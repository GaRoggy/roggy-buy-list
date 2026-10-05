import { MonitorError, pages } from './core.mjs';

const clip = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) || null : null;

export function normalizeTask(task, list) {
  if (!task?.id || !list?.id) return null;
  const deleted = Boolean(task.deleted);
  return {
    kind: 'google_task', external_id: `${list.id}:${task.id}`,
    occurred_at: task.due || task.updated || null, status: deleted ? 'deleted' : 'processed',
    payload: {
      task_id: clip(task.id, 256), list_id: clip(list.id, 256), list_title: clip(list.title, 240),
      title: clip(task.title, 500) || '(Untitled task)', notes: clip(task.notes, 3000),
      due: clip(task.due, 80), completed: task.status === 'completed', status: clip(task.status, 40),
      completed_at: clip(task.completed, 80), updated: clip(task.updated, 80),
      parent: clip(task.parent, 256), position: clip(task.position, 256),
      web_view_link: clip(task.webViewLink, 1000),
    }
  };
}

export async function syncGoogleTasks(source, get) {
  const lists = await pages(get, 'tasks/v1/users/@me/lists', { maxResults: '100' });
  const records = [];
  for (const list of lists.items) {
    if (!list?.id) continue;
    const tasks = await pages(get, `tasks/v1/lists/${encodeURIComponent(list.id)}/tasks`, {
      maxResults: '100', showCompleted: 'true', showDeleted: 'true', showHidden: 'true'
    });
    for (const task of tasks.items) {
      const record = normalizeTask(task, list);
      if (record) records.push(record);
    }
  }
  return { records, cursor: { synced_at: new Date().toISOString(), list_count: lists.items.length } };
}

export function taskSourceExternalId(profile) {
  if (!profile?.emailAddress) throw new MonitorError('GOOGLE_ACCOUNT_REQUIRED', { terminal: true });
  return profile.emailAddress;
}
