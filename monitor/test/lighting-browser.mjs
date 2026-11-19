import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {staticFiles} from '../../scripts/static-files.mjs';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const root=new URL('../../',import.meta.url),allowed=new Set(staticFiles),server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  if(!allowed.has(name)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',/\.(?:m?js)$/.test(name)?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.jpg')?'image/jpeg':'text/html');
  try{res.end(await readFile(new URL(name,root)));}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`,out='C:/Codex/website-lighting-qa';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage({viewport:{width:1200,height:950}}),errors=[],commands=[];
page.on('pageerror',e=>errors.push(e.message));
const bulbs=[1,2,3].map(n=>({device_id:`mood_${n}`,friendly_name:`Living room mood ${n}`,type:'light',device_class:'light',room:'living_room',subcategory:'mood_lighting',capabilities:['power','brightness','color','color_temperature'],availability:'online',freshness:'fresh',state:'on',attributes:{brightness:45,rgb_color:[255,128,0],hs_color:[30,100],color_mode:'hs',color_temp_kelvin:2700,min_color_temp_kelvin:2000,max_color_temp_kelvin:6500}}));
bulbs.push({...structuredClone(bulbs[0]),device_id:'lamp',friendly_name:'Living room lamp',subcategory:'lamps'});
const now=new Date().toISOString(),run={id:'saved-run',routine_id:'morning_routine',started_at:now,ended_at:now,status:'completed',reason:'scheduled_automatic'};
const routines=[{id:'morning_routine',name:'Good Morning',summary:'Your morning briefing, Spanish word, and weather.',description:['First confirmed morning entry starts your routine.','Your exact briefing is saved for each run.'],enabled:true,running:false},{id:'home_arrival',name:'Home Arrival',summary:'Lights and welcome message.',description:['Lights and speech.'],enabled:true,running:false}];
await page.route('https://**/*',r=>r.fulfill({contentType:'text/javascript',body:''}));
await page.route('**/smart-home/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/smart-home'.length);let data={};
  if(path==='/diagnostics')data={smart_home:{status:'online'},voice:{microphones:[]}};
  else if(path==='/devices')data={devices:bulbs};
  else if(path==='/rooms')data={rooms:[{room_id:'living_room',friendly_name:'Living Room'}]};
  else if(path==='/events/history')data={events:[]};
  else if(path==='/api/voice-settings')data={rooms:[],state:'enabled'};
  else if(path==='/routines')data={routines,runs:[run]};
  else if(path.endsWith('/history'))data={runs:[run],total:1};
  else if(path.endsWith('/runs/saved-run'))data={...run,steps:[{type:'routine.briefing',timestamp:now,details:{generated_speech:'Good morning, Garrett. Your Spanish word is ánimo.',spanish_word:{word:'ánimo',meaning:'encouragement',example:'Mucho ánimo con tu trabajo.',example_translation:'Keep your spirits up with your work.'},weather:{location:'Home',current:{temperature_f:41,apparent_temperature_f:38,condition:'clear',wind_mph:5},today:{high_f:58,low_f:36,precipitation_probability_percent:10,uv_index_max:2},detailed_speech:'Clear and cool this morning.'}}}]};
  else if(path.endsWith('/actions')){const body=req.postDataJSON(),id=path.split('/')[2];commands.push({id,...body});const d=bulbs.find(d=>d.device_id===id);if(body.action==='color'){d.attributes.rgb_color=Object.values(body.color);delete d.attributes.hs_color;d.attributes.color_mode='rgb';}if(body.action==='color_temperature'){d.attributes.color_temp_kelvin=body.kelvin;d.attributes.color_mode='color_temp';}data={success:true};}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
});
await page.addInitScript(base=>{
  window.ROGGY_SMART_HOME_API=base+'/smart-home';
  const owner='9c1fcb62-644b-486a-9f87-36246e2e50de';window.__authCallbacks=[];
  const builder=()=>{const b=new Proxy({}, {get(_,key){if(key==='then')return resolve=>resolve({data:[],error:null,count:0});return ()=>b;}});return b;};
  window.supabase={createClient:()=>({from:()=>builder(),rpc:async()=>({data:[],error:null}),channel:()=>({on(){return this},subscribe(){return this},unsubscribe(){}}),removeChannel:()=>{},auth:{getSession:async()=>({data:{session:{user:{id:owner},access_token:'fixture'}}}),onAuthStateChange:fn=>{window.__authCallbacks.push(fn);return {data:{subscription:{unsubscribe(){}}}}},signOut:async()=>({error:null})}})};
},base);
try{
 await page.goto(base);await page.waitForFunction(()=>window.LightControls&&window.roggyLights.allowed());
 await page.evaluate(()=>setPage('devices'));await page.locator('[data-light-open="group|living_room|mood_lighting|"]').waitFor();
 assert.equal(await page.locator('#deviceRooms [data-device-card^="mood_"]').count(),0,'bulbs should live inside groups');
 await page.locator('[data-light-open="group|living_room|mood_lighting|"]').click();await page.locator('#lightControlDialog[open]').waitFor();
 assert.equal(await page.locator('[data-light-child]').count(),3);
 const wheel=page.locator('#deviceColorWheel');let box=await wheel.boundingBox();
 await page.mouse.move(box.x+box.width*.7,box.y+box.height*.4);await page.mouse.down();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.65,{steps:8});
 await page.waitForFunction(()=>document.querySelector('#lightControlStatus').textContent.includes('Updating'));
 await new Promise(r=>setTimeout(r,200));assert.ok(commands.length>0,'drag must send commands before release');assert.ok(commands.every(c=>c.id.startsWith('mood_')),'group command touched another group');
 await page.mouse.up();await new Promise(r=>setTimeout(r,500));
 const before=commands.length;await page.locator('#lightTintTab').click();assert.equal(commands.length,before,'switching mode must not send a color');
 box=await wheel.boundingBox();await page.mouse.move(box.x+box.width*.2,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.75,box.y+box.height*.5,{steps:7});await page.mouse.up();await new Promise(r=>setTimeout(r,700));
 assert.equal(commands.at(-1).action,'color_temperature');assert.ok(commands.at(-1).kelvin>5000);
 await page.locator('[data-light-child="mood_1"]').click();assert.equal(await page.locator('[data-light-child]').count(),0);await page.locator('#lightColorTab').click();const singleStart=commands.length;await wheel.press('ArrowRight');await new Promise(r=>setTimeout(r,200));assert.deepEqual([...new Set(commands.slice(singleStart).map(c=>c.id))],['mood_1']);
 await page.locator('#lightBack').click();assert.equal(await page.locator('[data-light-child]').count(),3);
 await page.waitForTimeout(250);await page.screenshot({path:out+'/group-desktop.png'});await page.locator('#lightClose').click();
 // Simulate a Layne command arriving through a later device snapshot.
 bulbs[0].attributes={...bulbs[0].attributes,hs_color:[240,80],color_mode:'hs'};
 await page.evaluate(()=>window.roggyLights.refresh());await page.evaluate(()=>window.LightControls.openDevice('mood_1'));
 await page.waitForFunction(()=>document.getElementById('deviceColorWheel').getAttribute('aria-valuenow')==='240',null,{timeout:2500}).catch(async error=>{console.log('external state debug',JSON.stringify(await page.evaluate(()=>window.roggyLights.devices().find(d=>d.device_id==='mood_1'))),JSON.stringify(commands.slice(-5)));throw error;});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await page.screenshot({path:out+'/bulb-mobile.png'});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile overflow');
 await page.locator('#lightClose').click();await page.evaluate(()=>document.getElementById('settingsToggle').checked=true);await page.waitForTimeout(400);
 const themeWheel=page.locator('#appThemeWheel'),themeBox=await themeWheel.boundingBox();const old=await page.evaluate(()=>document.documentElement.style.getPropertyValue('--accent'));
 await page.mouse.move(themeBox.x+themeBox.width*.5,themeBox.y+themeBox.height*.2);await page.mouse.down();await page.mouse.move(themeBox.x+themeBox.width*.8,themeBox.y+themeBox.height*.7,{steps:6});
 assert.notEqual(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--accent')),old);await page.mouse.up();assert.ok(await page.evaluate(()=>localStorage.getItem('roggy-custom-color')));
 await page.evaluate(()=>{document.getElementById('settingsToggle').checked=false;setPage('routines');});await page.locator('[data-routine-open="morning_routine"]').waitFor();await page.locator('[data-routine-open="morning_routine"]').click();await page.locator('[data-routine-run="saved-run"]').click();await page.locator('#routineEventDialog[open]').waitFor();
 assert.match(await page.locator('#routineEventDialog').innerText(),/ánimo/);assert.match(await page.locator('#routineEventDialog').innerText(),/41 °F/);assert.match(await page.locator('#routineEventDialog').innerText(),/Scheduled \/ automatic/);assert.equal(await page.locator('[data-pronounce]').count(),1);
 await page.waitForTimeout(250);await page.screenshot({path:out+'/morning-run-mobile.png'});await page.locator('[data-event-close]').click();await page.locator('[data-routine-tab="history"]').click();await page.locator('[data-routine-run="saved-run"]').waitFor();await page.locator('[data-routine-close]').click();
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('roggy-auth',{detail:{signedIn:false}})));assert.equal(await page.locator('#routinesList').innerText(),'');
 assert.deepEqual(errors,[]);console.log('Browser checks passed: live drag, latest mode, group isolation, individual controls, external sync, theme persistence, mobile layout, nested dialogs, saved briefing/history, signout privacy.');
}finally{await browser.close();server.close();}
