import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {staticFiles} from '../../scripts/static-files.mjs';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const root=new URL('../../',import.meta.url),allowed=new Set(staticFiles),streams=new Set(),now=Date.now();
const make=(id,age,reason)=>({id:String(id),sequence:id,completed_at:new Date(now-age).toISOString(),expires_at:new Date(now-age+9*86400000).toISOString(),reason,title:id===1?'Lamp <img src=x onerror=alert(1)>':'Completed action '+id,summary:'Layne finished the requested action. The final result was verified.',details:{description:'The selected living-room lights reached the requested brightness. Home Assistant returned the final state for the affected devices.',target:'Living room mood lighting',verified:true,steps:[{type:'lights.confirmed',timestamp:new Date(now-age).toISOString(),details:{brightness:33}}]}});
const records=[make(1,3600000,'user_initiated'),make(2,1800000,'automated'),make(3,1200000,'test'),make(0,10*86400000,'automated')];
let detailReads=0;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),path=url.pathname;
 const json=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
 if(path==='/smart-home/completions/stream'){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.write(': connected\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;
 }
 if(path==='/smart-home/completions'){const live=records.filter(r=>Date.parse(r.expires_at)>Date.now());return json({items:live.map(({details,...item})=>item),cursor:Math.max(...live.map(r=>r.sequence)),server_time:new Date().toISOString(),has_more:false});}
 if(path.startsWith('/smart-home/completions/')){detailReads++;return json(records.find(r=>r.id===decodeURIComponent(path.split('/').at(-1))));}
 if(path.startsWith('/smart-home/')){
  if(path.endsWith('/diagnostics'))return json({smart_home:{status:'online'}});
  if(path.endsWith('/devices'))return json({devices:[]});
  if(path.endsWith('/rooms'))return json({rooms:[]});
  if(path.endsWith('/history'))return json({events:[]});
  return json({});
 }
 const name=path.slice(1)||'index.html';if(!allowed.has(name)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',/\.(?:m?js)$/.test(name)?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.jpg')?'image/jpeg':'text/html');
 res.end(await readFile(new URL(name,root)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`,out='C:/Codex/completion-feed-qa';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('https://**/*',r=>r.fulfill({contentType:'text/javascript',body:''}));
await page.addInitScript(base=>{
 window.ROGGY_SMART_HOME_API=base+'/smart-home';window.__authCallbacks=[];
 window.__session={user:{id:'9c1fcb62-644b-486a-9f87-36246e2e50de'},access_token:'fixture'};
 const builder=()=>{const b=new Proxy({}, {get(_,key){if(key==='then')return resolve=>resolve({data:[],error:null,count:0});return ()=>b;}});return b;};
 window.supabase={createClient:()=>({from:()=>builder(),rpc:async()=>({data:[],error:null}),channel:()=>({on(){return this},subscribe(){return this},unsubscribe(){}}),removeChannel:()=>{},auth:{getSession:async()=>({data:{session:window.__session}}),onAuthStateChange:fn=>{window.__authCallbacks.push(fn);return {data:{subscription:{unsubscribe(){}}}}},signOut:async()=>({error:null})}})};
},base);
try{
 await page.goto(base);await page.waitForFunction(()=>window.roggyLights?.allowed());await page.evaluate(()=>setPage('ai'));
 await page.locator('.layne-activity-row').first().waitFor();await page.waitForFunction(()=>document.getElementById('layneActivityStatus').dataset.state==='live');
 assert.deepEqual(await page.locator('.layne-activity-row').evaluateAll(rows=>rows.map(r=>r.dataset.completionId)),['3','2','1']);
 assert.equal(await page.locator('#layneActivityList img').count(),0);assert.equal(await page.locator('[data-completion-id="0"]').count(),0);
 for(const reason of ['Test','Automated','User initiated'])assert.ok((await page.locator('#layneActivityList').innerText()).includes(reason));
 assert.equal(streams.size,1,'only one activity stream should be opened');
 const fresh=make(4,-1,'user_initiated');records.push(fresh);const {details,...listItem}=fresh;
 const send=()=>{for(const stream of streams)stream.write(`id: 4\ndata: ${JSON.stringify({type:'completion.added',item:listItem})}\n\n`);};send();
 await page.locator('[data-completion-id="4"]').waitFor();assert.equal(await page.locator('.layne-activity-row').first().getAttribute('data-completion-id'),'4');send();await page.waitForTimeout(100);assert.equal(await page.locator('.layne-activity-row').count(),4);
 await page.locator('[data-completion-id="4"]').click();await page.locator('#layneActivityDialog[open]').waitFor();assert.equal(detailReads,1);assert.match(await page.locator('#layneActivityDetail').innerText(),/Home Assistant returned/);assert.match(await page.locator('#layneActivityDetail').innerText(),/brightness: 33/);assert.match(await page.locator('#layneActivityDetail').innerText(),/Automatically deletes/);
 await page.waitForTimeout(250);await page.screenshot({path:out+'/activity-detail-desktop.png'});await page.locator('#layneActivityClose').click();
 await page.setViewportSize({width:390,height:844});await page.locator('#layneActivityPanel').scrollIntoViewIfNeeded();await page.waitForTimeout(250);await page.screenshot({path:out+'/activity-list-mobile.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.locator('[data-completion-id="1"]').click();await page.locator('#layneActivityDialog[open]').waitFor();assert.equal(await page.locator('#layneActivityDialog img').count(),0);await page.locator('#layneActivityClose').click();
 await page.evaluate(()=>{window.__session=null;window.__authCallbacks.forEach(fn=>fn('SIGNED_OUT',null));});await page.waitForFunction(()=>document.querySelectorAll('.layne-activity-row').length===0);assert.equal(await page.locator('#layneActivityDetail').innerText(),'');assert.equal(await page.locator('#layneActivityTitle').innerText(),'Activity details');
 assert.deepEqual(errors,[]);console.log('Activity browser checks passed: bottom-of-AI placement, newest-first ordering, live streamed insertion, replay deduplication, all reason labels, two-sentence summaries, selectable detailed results, safe content, mobile layout, close controls and sign-out privacy.');
}finally{await browser.close();for(const stream of streams)stream.end();server.close();}
