import { readFile, readdir, lstat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Decoder, Stream } from '@garmin/fitsdk';
import { config, MonitorError, Store } from './core.mjs';
import { normalizeGarminCsv, normalizeGarminFitMessages, validateImportedRecords } from '../supabase/functions/_shared/garmin-normalize.js';

const MAX_FILES = 20000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const IMPORT_SOURCE_ID = 'official-export-import';

export async function decodeFit(bytes, { sourceTimezone = 'UTC' } = {}) {
  const stream = Stream.fromBuffer(bytes);
  const decoder = new Decoder(stream);
  if (!decoder.isFIT() || !decoder.checkIntegrity()) throw new MonitorError('GARMIN_FIT_INTEGRITY_FAILED', { terminal: true });
  const { messages, errors } = decoder.read();
  if (errors?.length) throw new MonitorError('GARMIN_FIT_DECODE_FAILED', { terminal: true });
  const records = await normalizeGarminFitMessages(messages, { sourceTimezone });
  return validateImportedRecords(records);
}

async function listFiles(rootPath) {
  const root = resolve(rootPath);
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new MonitorError('GARMIN_IMPORT_SYMLINK_UNSUPPORTED', { terminal: true });
  if (info.isFile()) {
    if (!['.fit', '.csv'].includes(extname(root).toLowerCase())) throw new MonitorError('GARMIN_IMPORT_UNSUPPORTED_FILE', { terminal: true });
    return [root];
  }
  if (!info.isDirectory()) throw new MonitorError('GARMIN_IMPORT_PATH_INVALID', { terminal: true });
  const files = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && ['.fit', '.csv'].includes(extname(entry.name).toLowerCase())) files.push(path);
      if (files.length + queue.length > MAX_FILES) throw new MonitorError('GARMIN_IMPORT_TOO_MANY_FILES', { terminal: true });
    }
  }
  return files;
}

export async function readGarminExport(inputPath, { sourceTimezone = 'UTC' } = {}) {
  const files = await listFiles(inputPath);
  const orderedFiles = await Promise.all(files.map(async path => ({ path, info: await lstat(path) })));
  // Files touched later generally come from newer full-account exports; read
  // them last so a corrected record with the same stable identity wins.
  orderedFiles.sort((left, right) => left.info.mtimeMs - right.info.mtimeMs || left.path.localeCompare(right.path));
  const records = new Map();
  let totalBytes = 0, filesRead = 0, warnings = 0;
  for (const { path, info } of orderedFiles) {
    if (info.size > MAX_FILE_BYTES) throw new MonitorError('GARMIN_IMPORT_FILE_TOO_LARGE', { terminal: true });
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new MonitorError('GARMIN_IMPORT_TOO_LARGE', { terminal: true });
    const bytes = await readFile(path);
    const extension = extname(path).toLowerCase();
    let parsed;
    if (extension === '.fit') parsed = { records: await decodeFit(bytes, { sourceTimezone }), warnings: [] };
    else {
      const result = await normalizeGarminCsv(bytes.toString('utf8'), { sourceTimezone });
      parsed = { records: validateImportedRecords(result.records), warnings: result.warnings };
    }
    filesRead++;
    warnings += parsed.warnings?.length || 0;
    for (const record of parsed.records) {
      const previous = records.get(`${record.kind}:${record.external_id}`);
      if (previous && JSON.stringify(previous.payload) !== JSON.stringify(record.payload)) warnings++;
      records.set(`${record.kind}:${record.external_id}`, record);
      if (records.size > 10000) throw new MonitorError('GARMIN_IMPORT_RECORD_LIMIT', { terminal: true });
    }
  }
  if (!filesRead || !records.size) throw new MonitorError('GARMIN_EXPORT_NO_SUPPORTED_RECORDS', { terminal: true });
  const imported = [...records.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return { records: imported, files_read: filesRead, warnings,
    coverage: { from: imported[0].occurred_at, through: imported.at(-1).occurred_at },
    metrics: [...new Set(imported.filter(row => row.kind === 'health_measurement').map(row => row.payload.metric))].sort(),
    activities: imported.filter(row => row.kind === 'garmin_activity').length };
}

async function ensureImportSource(store) {
  const userId = store.env.MONITOR_USER_ID;
  const params = new URLSearchParams({ user_id: `eq.${userId}`, kind: 'eq.garmin', external_id: `eq.${IMPORT_SOURCE_ID}`,
    select: 'id', limit: '1' });
  const existing = await store.api(`monitor_sources?${params}`);
  if (Array.isArray(existing) && existing[0]?.id) return existing[0].id;
  const created = await store.api('monitor_sources?on_conflict=user_id,kind,external_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ user_id: userId, kind: 'garmin', external_id: IMPORT_SOURCE_ID, enabled: false,
      interval_seconds: 3600, config: { method: 'official_export_import', credentials_stored: false } }]),
  });
  if (Array.isArray(created) && created[0]?.id) return created[0].id;
  const retry = await store.api(`monitor_sources?${params}`);
  if (Array.isArray(retry) && retry[0]?.id) return retry[0].id;
  throw new MonitorError('GARMIN_IMPORT_SOURCE_UNAVAILABLE');
}

export async function persistGarminExport(records, store = new Store(config())) {
  const safeRecords = validateImportedRecords(records);
  if (!safeRecords.length) throw new MonitorError('GARMIN_EXPORT_NO_SUPPORTED_RECORDS', { terminal: true });
  const sourceId = await ensureImportSource(store);
  const rows = safeRecords.map(record => ({ user_id: store.env.MONITOR_USER_ID, source_id: sourceId,
    kind: record.kind, external_id: record.external_id, occurred_at: record.occurred_at,
    status: 'processed', payload: record.payload }));
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    await store.api('monitor_records?on_conflict=source_id,kind,external_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch),
    });
  }
  const params = new URLSearchParams({ user_id: `eq.${store.env.MONITOR_USER_ID}`, id: `eq.${sourceId}` });
  await store.api(`monitor_sources?${params}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ enabled: false, last_attempt_at: new Date().toISOString(), last_success_at: new Date().toISOString(),
      records_processed: rows.length, error_code: null, next_run_at: new Date(Date.now() + 3600000).toISOString() }) });
  return { records_written: rows.length, source: IMPORT_SOURCE_ID };
}

export function importCliUsage() {
  return 'Usage: npm run garmin:import -- <export-folder-or-file> [--apply] [--timezone IANA_ZONE]\n' +
    'The default is a local dry run. Extract Garmin ZIP exports first; accepted input files are CSV and FIT.';
}

async function main() {
  const args = process.argv.slice(2);
  const input = args.find(value => !value.startsWith('--'));
  if (!input || args.includes('--help')) { console.log(importCliUsage()); return; }
  let sourceTimezone = process.env.MONITOR_TIMEZONE || 'America/Chicago';
  const zoneIndex = args.indexOf('--timezone');
  if (zoneIndex >= 0) sourceTimezone = args[zoneIndex + 1] || '';
  const result = await readGarminExport(input, { sourceTimezone });
  const summary = { mode: args.includes('--apply') ? 'apply' : 'dry_run', files_read: result.files_read,
    rows: result.records.length, metrics: result.metrics, activities: result.activities,
    coverage: result.coverage, warnings: result.warnings };
  if (args.includes('--apply')) Object.assign(summary, await persistGarminExport(result.records));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { const code = error instanceof MonitorError ? error.code : 'GARMIN_IMPORT_FAILED';
    console.error(code); process.exitCode = 1; });
}
