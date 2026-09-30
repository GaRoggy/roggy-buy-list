/*
 * Local calibration helper. It writes review metadata under .secrets (which
 * is gitignored) and never prints or persists full Gmail bodies.
 *
 *   node --env-file=.env monitor/calibrate-email.mjs --sample
 *   node --env-file=.env monitor/calibrate-email.mjs --evaluate
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { config, Store } from './core.mjs';
import { routeEmail } from './email-routing.mjs';
import { evaluateEmailClassifier, representativeSample } from './email-calibration.mjs';

const path = '.secrets/email-review-sample.json';

async function main() {
  const env = config();
  if (process.argv.includes('--sample')) {
    const records = await new Store(env).records('email');
    const sample = representativeSample(records, { limit: 60 });
    await mkdir('.secrets', { recursive: true });
    await writeFile(path, JSON.stringify({ created_at: new Date().toISOString(), instructions: 'Add expected.route and expected field labels locally; do not add message bodies.', rows: sample.map(row => ({ ...row, expected: {} })) }, null, 2), { encoding: 'utf8' });
    console.log(JSON.stringify({ sample_path: path, sample_size: sample.length, fields: ['route', 'action_required', 'needs_reply', 'finance_related', 'low_value'] }));
    return;
  }
  if (process.argv.includes('--evaluate')) {
    const document = JSON.parse(await readFile(path, 'utf8'));
    const rows = Array.isArray(document.rows) ? document.rows : [];
    const expected = Object.fromEntries(rows.map(row => [row.id, row.expected || {}]));
    const result = evaluateEmailClassifier(rows, { expected, classify: row => routeEmail({ category: row.category, sender: row.sender, subject: row.subject, text: row.summary, labels: [] }) });
    console.log(JSON.stringify({ sample_size: result.sample_size, route_metrics: result.route_metrics, field_metrics: result.field_metrics, calibration: result.calibration, confidence_buckets: result.confidence_buckets }));
    return;
  }
  console.error('Use --sample or --evaluate.');
  process.exitCode = 2;
}
main().catch(error => { console.error(error?.code || 'EMAIL_CALIBRATION_FAILED'); process.exitCode = 1; });

