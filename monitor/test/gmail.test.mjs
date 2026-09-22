import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmail, syncGmail } from '../gmail.mjs';
import { MonitorError } from '../core.mjs';
const message = (subject, labels = [], body = '') => ({ id:'id', internalDate:'1790000000000', labelIds:labels, snippet:body,
  payload:{ headers:[{name:'Subject',value:subject},{name:'From',value:'sender@example.test'}] } });
test('promotional security keywords do not produce dashboard alerts', () => {
  const row = classifyEmail(message('50% OFF security alert tools', ['CATEGORY_PROMOTIONS']));
  assert.equal(row.dashboard,false); assert.equal(row.category,'promotions');
});
test('actionable bills retain evidence without guessing dollar currency or relative dates', () => {
  const row = classifyEmail(message('Internet bill', [], '$64.99 due tomorrow'));
  assert.equal(row.dashboard,true); assert.equal(row.monetary_amount,null); assert.equal(row.due_date,null);
  const explicit = classifyEmail(message('Invoice USD 64.99 due 2026-10-02'));
  assert.deepEqual(explicit.monetary_amount,{amount:'64.99',currency:'USD'}); assert.equal(explicit.due_date,'2026-10-02');
});
test('expired history resets, preserves bootstrap boundary and records deletions', async () => {
  const get = async (path) => {
    if(path.endsWith('history')) throw new MonitorError('HTTP_404',{status:404});
    if(path.endsWith('profile')) return {historyId:'100'};
    if(path.endsWith('messages')) return {messages:[{id:'new'}]};
    if(path.endsWith('gone')) throw new MonitorError('HTTP_404',{status:404});
    return {...message('Invoice'),id:'new'};
  };
  const output = await syncGmail({id:'s',cursor:{historyId:'old'}},get,[{source_id:'s',external_id:'gone'}]);
  assert.equal(output.cursor.historyId,'100'); assert.equal(output.records[1].status,'deleted');
});
test('label changes revisit messages and history records deduplicate IDs', async () => {
  let reads=0;
  const output = await syncGmail({cursor:{historyId:'old'}},async path => {
    if(path.endsWith('history'))return{historyId:'new',history:[{messages:[{id:'id'},{id:'id'}]}]};
    reads++; return message('Invoice',['TRASH']);
  });
  assert.equal(reads,1);assert.equal(output.records[0].payload.dashboard,false);
});
