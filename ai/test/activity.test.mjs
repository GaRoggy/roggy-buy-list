import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeCompletions,RETENTION_MS} from '../../activity-model.mjs';
const now=Date.now(),row=(id,age,reason='user_initiated')=>({id,reason,sequence:Number(id)||1,completed_at:new Date(now-age).toISOString()});
test('completion list is newest first, deduplicates stream replays, and removes nine-day entries',()=>{
 const rows=mergeCompletions([row('1',100),row('2',10)],[row('1',100),row('3',RETENTION_MS),row('4',0,'test')],now);
 assert.deepEqual(rows.map(x=>x.id),['4','2','1']);
 assert.equal(mergeCompletions(rows,[],now+RETENTION_MS).length,0);
});
test('invalid and unsupported completion records cannot enter the activity list',()=>{
 assert.equal(mergeCompletions([], [{id:'bad',reason:'unknown',completed_at:new Date().toISOString()},row('1',0,'automated')],now).length,1);
});
