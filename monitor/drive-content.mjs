import { config, failure } from './core.mjs';
import { googleClient } from './google.mjs';
import { fetchDriveContent } from './drive.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

async function main() {
  const fileId = argument('--file-id');
  const mimeType = argument('--mime-type');
  const maxBytes = Number(argument('--max-bytes') || 200000);
  const result = await fetchDriveContent(await googleClient(config()), fileId,
                                         { mimeType, maxBytes: Number.isFinite(maxBytes) ? maxBytes : 200000 });
  if (/^application\/pdf$|^application\/zip$|^application\/x-7z-compressed$/i.test(result.mime_type)) {
    throw Object.assign(new Error('BINARY_CONTENT_UNSUPPORTED'), { code: 'DRIVE_BINARY_CONTENT_UNSUPPORTED' });
  }
  process.stdout.write(JSON.stringify({ file_id: result.file_id, mime_type: result.mime_type, content: result.content }));
}

main().catch(error => { console.error(failure(error).code); process.exitCode = 1; });
