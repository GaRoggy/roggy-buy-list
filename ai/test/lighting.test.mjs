import test from 'node:test';
import assert from 'node:assert/strict';
import {pointToColor,colorToPoint,hsvToRgb,rgbToHsv,LatestLightQueue} from '../../lighting-model.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('wheel positions roundtrip through full spectrum and saturation, including outside edges',()=>{
  for(const h of [0,30,60,120,180,240,300,359])for(const s of [.05,.5,1]){
    const p=colorToPoint(h,s),v=pointToColor(p.x,p.y);assert.ok(Math.abs(v.h-h)<1e-8);assert.ok(Math.abs(v.s-s)<1e-8);
    const rgb=hsvToRgb(h,s),round=rgbToHsv(rgb);assert.ok(Math.abs(round.s-s)<.01);
  }
  assert.equal(pointToColor(4,4).s,1);assert.deepEqual(pointToColor(0,0).rgb,[255,255,255]);
});
test('drag sends before release, coalesces old values, and latest mode always wins',async()=>{
  const sent=[],pending=[];const q=new LatestLightQueue((id,body)=>{sent.push([id,body]);return new Promise(r=>pending.push(r))},{interval:0});
  q.put('bulb',{action:'color',value:'red'});assert.equal(sent.length,1);
  q.put('bulb',{action:'color',value:'green'});q.put('bulb',{action:'color_temperature',value:2700});
  assert.equal(sent.length,1);pending.shift()({success:true});await sleep(0);
  assert.deepEqual(sent.map(x=>x[1].action),['color','color_temperature']);
  pending.shift()({success:true});await sleep(0);assert.equal(q.active,false);
});
test('group bulbs run concurrently and a rejected bulb does not block the rest',async()=>{
  const sent=[],errors=[];const q=new LatestLightQueue(async(id,body)=>{sent.push(id);if(id==='bad')throw Error('offline');return {success:true}},{interval:0,onResult:(id,item,error)=>{if(error)errors.push(id)}});
  q.put('good',{action:'color'});q.put('bad',{action:'color'});await sleep(0);
  assert.deepEqual(sent,['good','bad']);assert.deepEqual(errors,['bad']);assert.equal(q.active,false);
});
