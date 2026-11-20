import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {LatestLightBatchQueue,mergeLightPatch} from '../../lighting-model.mjs';
async function idle(queue){for(let n=0;n<200&&queue.active;n++)await sleep(10);assert.equal(queue.active,false);}

test('a later power or color change releases a queued zero-brightness off setting',()=>{
  const off=mergeLightPatch({},{action:'brightness',value:0});
  for(const body of [{action:'power',value:'on'},{action:'color',color:{r:255,g:0,b:0}},{action:'color_temperature',kelvin:3000}]){
    const next=mergeLightPatch(off,body);assert.equal(next.power,'on');assert.equal(next.brightness,undefined);
  }
});

test('six bulbs share one request and retain brightness across rapid mode changes',async()=>{
  const sent=[],accepted=[];
  const q=new LatestLightBatchQueue(async body=>{sent.push(body);return {success:true,revision:1}}, {interval:0,onAccepted:items=>accepted.push(...items)});
  for(let n=0;n<6;n++){
    q.put('bulb'+n,{action:'brightness',value:65});
    q.put('bulb'+n,{action:'color',color:{r:255,g:0,b:90}});
    q.put('bulb'+n,{action:'color_temperature',kelvin:4300});
  }
  await idle(q);assert.equal(sent.length,1);assert.equal(sent[0].updates.length,6);
  assert.ok(sent[0].updates.every(d=>d.brightness===65&&d.kelvin===4300&&!d.color));
  assert.equal(accepted.length,6);
  for(const item of accepted)q.confirm(item.id,item.version);
  q.put('bulb0',{action:'power',value:'off'});await idle(q);
  assert.deepEqual(sent.at(-1).updates,[{device_id:'bulb0',power:'off'}]);
});

test('429 and transient network failures retry the latest settings without dropping bulbs',async()=>{
  let count=0;const sent=[],failed=[],accepted=[];
  const q=new LatestLightBatchQueue(async body=>{sent.push(body);if(++count<3)throw Object.assign(Error('busy'),{status:429});return {success:true,revision:1}},
    {interval:0,onFailure:item=>failed.push(item),onAccepted:items=>accepted.push(...items)});
  for(let n=0;n<6;n++)q.put('b'+n,{action:'color',color:{r:0,g:255,b:80}});
  await sleep(40);
  for(let n=0;n<6;n++)q.put('b'+n,{action:'color_temperature',kelvin:5200});
  await idle(q);assert.equal(failed.length,0);assert.equal(accepted.length,6);
  assert.ok(sent.at(-1).updates.every(d=>d.kelvin===5200&&!d.color));
});

test('superseded in-flight failure cannot retry an older color after the latest power setting',async()=>{
  let release;const sent=[];
  const q=new LatestLightBatchQueue(async body=>{sent.push(body);if(sent.length===1)await new Promise(r=>release=r);return {success:true,revision:sent.length}}, {interval:0});
  q.put('b',{action:'color',color:{r:255,g:10,b:0}});await sleep(15);
  q.put('b',{action:'brightness',value:30});q.put('b',{action:'power',value:'off'});release();await idle(q);
  assert.equal(sent.length,2);assert.equal(sent[1].updates[0].power,'off');assert.equal(sent[1].updates[0].brightness,30);
});

test('permanent rejection reports a failure and signout prevents late callbacks',async()=>{
  let failure=0,accepted=0,release;
  const q=new LatestLightBatchQueue(async()=>{throw Object.assign(Error('unsupported'),{status:400})},{interval:0,onFailure:()=>failure++});
  q.put('b',{action:'brightness',value:70});await idle(q);assert.equal(failure,1);
  const signingOut=new LatestLightBatchQueue(async()=>{await new Promise(r=>release=r);return {success:true}},{interval:0,onAccepted:()=>accepted++});
  signingOut.put('b',{action:'power',value:'off'});await sleep(15);signingOut.clear();release();await idle(signingOut);assert.equal(accepted,0);
});
