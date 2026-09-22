import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, calendarAnalysis, linkContexts } from '../brief.mjs';
const event=(id,start,end)=>({id,payload:{title:id,start,end,all_day:false}});
test('calendar conflicts include nested events but not adjacent events',()=>{
  const rows=[event('a','2026-09-21T09:00:00-05:00','2026-09-21T12:00:00-05:00'),event('b','2026-09-21T10:00:00-05:00','2026-09-21T11:00:00-05:00'),event('c','2026-09-21T12:00:00-05:00','2026-09-21T13:00:00-05:00')];
  const s=calendarAnalysis(rows,new Date('2026-09-21T08:00:00-05:00'),'America/Chicago');assert.equal(s.conflicts.length,1);assert.equal(s.scheduled_hours,4);
});
test('brief contains structured empty sections and unknown health rather than sample values',()=>{
  const b=buildBrief({},new Date('2026-09-21T08:00:00-05:00'));
  assert.deepEqual(Object.keys(b.sections),['TODAY','IMPORTANT','MONEY','HEALTH','REMINDERS','PACKAGES']);
  assert.equal(b.sections.HEALTH.sleep_stress_association.status,'insufficient_data');assert.deepEqual(b.alerts,[]);
});
test('cross-source links require exact evidence, not shared dates or partial identifiers',()=>{
  const emails=[{id:'e',payload:{order_information:'ABC12345'}}];
  assert.equal(linkContexts(emails,[{id:'t',payload:{name:'ABC123456'}}]).length,0);
  assert.equal(linkContexts(emails,[{id:'t',payload:{name:'Hotel ABC12345'}}])[0].confidence,'candidate');
});
