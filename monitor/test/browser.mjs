import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const root=new URL('../../',import.meta.url);
const allowed=['index.html','app.js','monitor-ui.js','styles.css','manifest.json','icon.svg','sw.js'];
const server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!allowed.includes(name)){res.writeHead(404);res.end();return}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL(name,root)))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.fulfill({contentType:'text/javascript',body:''}));
 const ownerId=(await readFile(new URL('app.js',root),'utf8')).match(/const OWNER_USER_ID="([^"]+)"/)[1];
 await page.addInitScript((ownerId)=>{
  window.__session={user:{id:ownerId,email:'fixture@example.test'}};window.__reads=0;
  const chain=(table)=>{let query={};const obj={};for(const method of ['select','eq','neq','gte','is','order','limit'])obj[method]=(...args)=>{query[args[0]]=args[1];return obj};obj.then=(resolve)=>{
   let data=[];if(table==='reminders'){window.__reads++;data=[]}
   if(table==='monitor_sources')data=[{kind:'gmail',enabled:true,interval_seconds:300,last_success_at:new Date().toISOString()}];
   if(table==='monitor_records'&&query.kind==='email')data=[{payload:{subject:'<img src=x onerror=alert(1)>',sender:'Fixture sender',summary:'Synthetic security message',category:'security',reason:'Synthetic test reason',timestamp:new Date().toISOString(),source_message_id:'test'}}];
   return Promise.resolve({data,error:null}).then(resolve);
  };return obj};
  window.supabase={createClient:()=>({from:chain,auth:{getSession:async()=>({data:{session:window.__session}}),onAuthStateChange:fn=>{window.__authChange=fn},signOut:async()=>({}),signInWithOAuth:async()=>({data:{}})}})};
 },ownerId);
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByText('Synthetic security message',{exact:false}).waitFor();
 if(await page.locator('#importantEmailList img').count())throw Error('Unsafe HTML');
 if(process.argv[3])await page.screenshot({path:process.argv[3],fullPage:true});
 await page.evaluate(()=>{window.__session=null;window.__authChange('SIGNED_OUT',null)});
 await page.locator('#privacyGate').waitFor();
 if((await page.locator('#monitorSection').textContent())!=='Sign in to view monitoring status.')throw Error('Monitoring state not cleared');
 if(await page.locator('#importantEmailList').textContent().then(t=>t.includes('Fixture sender')))throw Error('Private state survived signout');
 if(await page.evaluate(()=>window.__reads)>4)throw Error('Reminder fetch loop');
 if(errors.length)throw Error(errors.join('; '));
 console.log('UI checks passed: signed-in fixture rendering, HTML escaping, empty-reminder no-loop, sign-out state clearing, no page exceptions.');
}finally{await browser?.close();server.close()}
