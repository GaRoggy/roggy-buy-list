import test from 'node:test';
import assert from 'node:assert/strict';
import { correlation, measurement, dailyHealth, syncGarmin } from '../health.mjs';
test('health requires real finite data and correct units',()=>{
  assert.throws(()=>measurement({external_id:'x',metric:'hrv',value:null,unit:'ms',timestamp:'2026-09-21'}));
  assert.throws(()=>measurement({external_id:'x',metric:'hrv',value:30,unit:'bpm',timestamp:'2026-09-21'}));
});
test('correlations count unique dates and never claim causation',()=>{
  assert.equal(correlation(Array.from({length:50},()=>({date:'one',x:1,y:2}))).status,'insufficient_data');
  const result=correlation(Array.from({length:30},(_,i)=>({date:String(i),x:i,y:i*2})));
  assert.equal(result.sample_size,30);assert.equal(result.pearson_r,1);assert.match(result.explanation,/not evidence of causation/);
});
test('daily metrics preserve availability without filling missing data',()=>{
  const r=measurement({external_id:'x',metric:'steps',value:40,unit:'count',timestamp:'2026-09-21T18:00:00Z'});
  const d=dailyHealth([r],'America/Chicago')[0];assert.equal(d.metrics.steps.value,40);assert.equal(d.metrics.hrv,undefined);
});
test('Garmin cannot silently return successful empty or sample data',async()=>{
  await assert.rejects(syncGarmin(),e=>e.code==='GARMIN_APPROVED_API_ACCESS_REQUIRED'&&e.terminal);
});
