// Run: node monitor/test/database.mjs <absolute path to PGlite dist/index.js>
// PGlite 0.5.8 is a disposable PostgreSQL WASM test database, never production.
import { pathToFileURL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated;
create table public.reminders(id uuid primary key default gen_random_uuid(),title text not null,start_at timestamptz not null,
end_at timestamptz,all_day boolean not null default false,source text not null default 'manual',external_id text unique,completed boolean not null default false,created_at timestamptz default now());
create table public.budget_entries(user_id uuid);
insert into auth.users values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.budget_entries values('00000000-0000-4000-8000-000000000001');`);
for (const file of (await readdir('supabase/migrations')).sort()) await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
const owner = '00000000-0000-4000-8000-000000000001';
const { rows: [source] } = await db.query(`insert into monitor_sources(user_id,kind,external_id,enabled) values($1,'gmail','test',true) returning *`, [owner]);
await db.query('select monitor_schedule($1)', [owner]); await db.query('select monitor_schedule($1)', [owner]);
assert.equal((await db.query('select * from monitor_jobs')).rows.length, 1);
const claim = (await db.query('select monitor_claim($1) as claim', [owner])).rows[0].claim;
assert.equal((await db.query('select monitor_claim($1) as claim', [owner])).rows[0].claim, null);
const record = { kind: 'email', external_id: 'test-message', occurred_at: '2026-09-21T12:00:00Z', payload: { subject: 'synthetic' } };
await assert.rejects(db.query('select monitor_commit($1,$2,$3,$4)', [claim.job.id, '00000000-0000-4000-8000-000000000000', JSON.stringify([record]), '{}']));
await db.query('select monitor_commit($1,$2,$3,$4)', [claim.job.id, claim.job.lease_token, JSON.stringify([record]), '{"historyId":"1"}']);
await db.exec(`update monitor_sources set next_run_at=now();`);
await db.query('select monitor_schedule($1)', [owner]);
const claim2 = (await db.query('select monitor_claim($1) as claim', [owner])).rows[0].claim;
await assert.rejects(db.query('select monitor_commit($1,$2,$3,$4)', [claim2.job.id, claim2.job.lease_token,
  JSON.stringify([record,{kind:'email',external_id:'broken',occurred_at:'bad-date',payload:{}}]), '{"historyId":"bad"}']));
assert.equal((await db.query('select cursor from monitor_sources where id=$1',[source.id])).rows[0].cursor.historyId,'1');
await db.query('select monitor_commit($1,$2,$3,$4)', [claim2.job.id, claim2.job.lease_token, JSON.stringify([record]), '{"historyId":"2"}']);
assert.equal((await db.query('select * from monitor_records')).rows.length, 1);
await db.exec(`set role authenticated; set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';`);
assert.equal((await db.query('select * from monitor_records')).rows.length, 0);
await assert.rejects(db.query('select monitor_schedule($1)',[owner]));
await db.exec(`set request.jwt.claim.sub='${owner}';`);
assert.equal((await db.query('select * from monitor_records')).rows.length,1);
await db.exec('reset role; set role anon;');
await assert.rejects(db.query('select * from monitor_records'));
await db.exec('reset role;');
await db.close();
console.log('Database checks passed: migration, scheduling deduplication, lease fencing, atomic rollback, record deduplication, owner isolation, anonymous denial.');
