import { MonitorError } from './core.mjs';

const clip = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) || null : null;
const fields = 'nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,parents,owners(displayName,emailAddress),webViewLink,trashed,capabilities(canDownload))';

export function normalizeDriveFile(file) {
  if (!file?.id) return null;
  const deleted = Boolean(file.trashed);
  return { kind: 'google_drive_file', external_id: file.id,
    occurred_at: file.modifiedTime || file.createdTime || null, status: deleted ? 'deleted' : 'processed',
    payload: { file_id: clip(file.id, 256), name: clip(file.name, 500) || '(Unnamed file)',
      mime_type: clip(file.mimeType, 200), modified_time: clip(file.modifiedTime, 80), created_time: clip(file.createdTime, 80),
      parent_ids: Array.isArray(file.parents) ? file.parents.slice(0, 20).map(id => clip(id, 256)).filter(Boolean) : [],
      owner: file.owners?.[0] ? { name: clip(file.owners[0].displayName, 200), email: clip(file.owners[0].emailAddress, 320) } : null,
      web_view_link: clip(file.webViewLink, 1000), trashed: deleted, can_download: file.capabilities?.canDownload !== false }
  };
}

async function listFiles(get, pageToken) {
  return get('drive/v3/files', { q: 'trashed = false', spaces: 'drive', pageSize: '1000', orderBy: 'modifiedTime desc', fields, ...(pageToken ? { pageToken } : {}) });
}

export async function syncDriveMetadata(source, get) {
  const cursor = source.cursor && typeof source.cursor === 'object' ? source.cursor : {};
  const records = [];
  if (!cursor.start_page_token || cursor.snapshot_in_progress) {
    // Establish the change boundary before the bounded snapshot. If a large
    // Drive needs several cycles, the cursor lets us resume the listing while
    // preserving the boundary for the first incremental change scan.
    const boundary = cursor.start_page_token || (await get('drive/v3/changes/startPageToken', { fields: 'startPageToken' })).startPageToken;
    let pageToken = cursor.list_page_token || undefined; let count = Number(cursor.files || 0);
    for (let page = 0; page < 100; page++) {
      const data = await listFiles(get, pageToken);
      for (const file of data.files || []) { const record = normalizeDriveFile(file); if (record) records.push(record); }
      count += (data.files || []).length;
      if (!data.nextPageToken) { pageToken = undefined; break; }
      pageToken = data.nextPageToken;
    }
    if (pageToken) {
      return { records, cursor: { ...cursor, start_page_token: boundary, list_page_token: pageToken,
        snapshot_in_progress: true, synced_at: new Date().toISOString(), full_index: false, files: count } };
    }
    return { records, cursor: { start_page_token: boundary, synced_at: new Date().toISOString(), full_index: true, files: count } };
  }
  let pageToken = cursor.start_page_token, newStartPageToken = null;
  for (let page = 0; page < 100; page++) {
    const data = await get('drive/v3/changes', { pageToken, includeItemsFromAllDrives: 'false', spaces: 'drive', pageSize: '1000', fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,createdTime,parents,owners(displayName,emailAddress),webViewLink,trashed,capabilities(canDownload)))' });
    for (const change of data.changes || []) {
      if (change.removed) records.push({ kind: 'google_drive_file', external_id: change.fileId, occurred_at: null, status: 'deleted', payload: { file_id: change.fileId, trashed: true } });
      else { const record = normalizeDriveFile(change.file); if (record) records.push(record); }
    }
    newStartPageToken = data.newStartPageToken || newStartPageToken;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  if (!newStartPageToken) throw new MonitorError('DRIVE_CURSOR_INVALID');
  return { records, cursor: { ...cursor, start_page_token: newStartPageToken, synced_at: new Date().toISOString(), full_index: false } };
}

export async function fetchDriveContent(get, fileId, { mimeType = '', maxBytes = 200000, exportMime = 'text/plain' } = {}) {
  if (!/^[A-Za-z0-9_-]{5,256}$/.test(fileId)) throw new MonitorError('DRIVE_FILE_ID_INVALID', { terminal: true });
  const googleMime = String(mimeType || '');
  const isGoogleDoc = googleMime === 'application/vnd.google-apps.document';
  const path = isGoogleDoc ? `drive/v3/files/${encodeURIComponent(fileId)}/export` : `drive/v3/files/${encodeURIComponent(fileId)}`;
  const result = await get.raw(path, isGoogleDoc ? { mimeType: exportMime } : { alt: 'media' });
  const bytes = new Uint8Array(result.body);
  if (bytes.byteLength > maxBytes) throw new MonitorError('DRIVE_CONTENT_TOO_LARGE', { terminal: true });
  return { file_id: fileId, mime_type: result.contentType || googleMime || 'application/octet-stream', content: new TextDecoder().decode(bytes).slice(0, maxBytes) };
}
