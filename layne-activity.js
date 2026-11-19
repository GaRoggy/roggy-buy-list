import {REASONS,mergeCompletions,expiryTime,detailText} from './activity-model.mjs';

const api=window.roggyLights,$=id=>document.getElementById(id),root=$('layneActivityList');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=value=>new Intl.DateTimeFormat(undefined,{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(value));
const base=(window.ROGGY_SMART_HOME_API||window.ROGGY_AI_CONFIG?.smartHomeUrl||'').replace(/\/$/,'');
let items=[],cursor=0,before=null,hasMore=false,loaded=false,generation=0,controller=null,retryTimer=null,expiryTimer=null,retryDelay=1000,clockOffset=0,detailId=null,starting=false;
const dialog=$('layneActivityDialog');
function status(text,state=''){const el=$('layneActivityStatus');el.textContent=text;el.dataset.state=state;}
const visible=()=>!$('aiPage').hidden&&!document.hidden&&api.allowed();
function render(){
  items=mergeCompletions(items,[],Date.now()+clockOffset);
  root.innerHTML=items.map(item=>`<button type="button" class="layne-activity-row" data-completion-id="${esc(item.id)}"><span class="layne-activity-meta"><time datetime="${esc(item.completed_at)}">${esc(stamp(item.completed_at))}</time><span class="layne-activity-reason" data-reason="${esc(item.reason)}">${REASONS[item.reason]}</span></span><b>${esc(item.title)}</b><p>${esc(item.summary)}</p><span class="layne-activity-detail-hint">View details <span aria-hidden="true">›</span></span></button>`).join('');
  $('layneActivityEmpty').hidden=items.length>0||!loaded;
  $('layneActivityMore').hidden=!hasMore;
  $('layneActivityCount').textContent=items.length?`${items.length} recent ${items.length===1?'completion':'completions'}`:'';
  clearTimeout(expiryTimer);
  if(items.length){const next=Math.min(...items.map(expiryTime));expiryTimer=setTimeout(()=>{if(detailId&&expiryTime(items.find(item=>item.id===detailId)||{})<=Date.now()+clockOffset)dialog.close();render();},Math.max(50,next-Date.now()-clockOffset+50));}
}
async function load({older=false}={}){
  const version=generation;
  if(!loaded)status('Loading completed activity…','loading');
  const url='/completions?limit=50'+(older&&before!=null?'&before='+before:'');
  const data=await api.fetch(url);
  if(version!==generation||!visible())return;
  if(data.server_time)clockOffset=Date.parse(data.server_time)-Date.now();
  items=mergeCompletions(items,data.items||[],Date.now()+clockOffset);
  if(!loaded){cursor=Number(data.cursor)||0;before=data.next_before;hasMore=!!data.has_more;}
  else if(older){before=data.next_before;hasMore=!!data.has_more;}
  loaded=true;render();
}
async function connect(version){
  const abort=new AbortController();controller=abort;
  try{
    const {data:{session}}=await window.roggyGetSession();
    if(version!==generation||!visible()||!session?.access_token)return;
    const response=await fetch(`${base}/completions/stream?after=${cursor}`,{headers:{Accept:'text/event-stream',Authorization:'Bearer '+session.access_token},cache:'no-store',signal:abort.signal});
    if(!response.ok||!response.body)throw Error('Completion stream unavailable');
    status('Live · newest first','live');retryDelay=1000;
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(!abort.signal.aborted){
      const {value,done}=await reader.read();if(done)throw Error('Completion stream ended');
      buffer+=decoder.decode(value,{stream:true});const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop()||'';
      for(const frame of frames){
        const text=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');if(!text)continue;
        let data;try{data=JSON.parse(text)}catch{continue;}
        if(version!==generation||!visible())return;
        if(data.type==='completion.added'&&data.item){cursor=Math.max(cursor,Number(data.item.sequence)||0);items=mergeCompletions(items,[data.item],Date.now()+clockOffset);render();}
      }
    }
  }catch(error){
    if(!abort.signal.aborted&&version===generation&&visible()){status(items.length?'Reconnecting · showing saved activity':'Reconnecting to activity history…','reconnecting');scheduleRetry(version);}
  }finally{if(controller===abort)controller=null;}
}
function scheduleRetry(version){if(retryTimer)return;const delay=retryDelay;retryDelay=Math.min(30000,retryDelay*2);retryTimer=setTimeout(()=>{retryTimer=null;if(version===generation&&visible())start(false);},delay);}
function stop({clear=false}={}){generation++;starting=false;controller?.abort();controller=null;clearTimeout(retryTimer);retryTimer=null;if(clear){clearTimeout(expiryTimer);items=[];loaded=false;cursor=0;before=null;hasMore=false;detailId=null;dialog.close();$('layneActivityDetail').replaceChildren();$('layneActivityTitle').textContent='Activity details';root.replaceChildren();$('layneActivityCount').textContent='';$('layneActivityEmpty').hidden=true;$('layneActivityMore').hidden=true;status('Sign in to view Layne’s completed activity.');}}
async function start(reload=true){
  if(!visible()||controller||starting)return;
  starting=true;
  const version=generation;
  try{if(!loaded||reload)await load();if(version===generation&&visible())connect(version);}
  catch{if(version===generation&&visible()){status(items.length?'Connection unavailable · showing saved activity':'Completed activity is temporarily unavailable.','reconnecting');scheduleRetry(version);}}
  finally{if(version===generation)starting=false;}
}
function paragraphs(text){return String(text||'').split(/\n+/).filter(Boolean).map(p=>`<p>${esc(p)}</p>`).join('');}
async function detail(id){
  const version=generation;
  try{
    const item=await api.fetch('/completions/'+encodeURIComponent(id));
    if(version!==generation||!visible())return;
    detailId=id;const d=item.details||{},steps=d.steps||d.result?.completed_steps||[],description=d.description||item.summary;
    $('layneActivityTitle').textContent=item.title;
    $('layneActivityDetail').innerHTML=`<div class="layne-activity-detail-meta"><time datetime="${esc(item.completed_at)}">${esc(stamp(item.completed_at))}</time><span class="layne-activity-reason" data-reason="${esc(item.reason)}">${REASONS[item.reason]}</span></div><section class="layne-activity-detail-section"><h3>What was achieved</h3>${paragraphs(description)}${description!==item.summary?`<p>${esc(item.summary)}</p>`:''}</section><section class="layne-activity-detail-section"><h3>Why it ran</h3><p>${item.reason==='test'?'This action ran as a test or diagnostic check.':item.reason==='automated'?'This action ran automatically through a routine, schedule, or background task.':'This action completed in response to a user request.'}</p></section>${d.target?`<p><b>Target</b> ${esc(d.target)}</p>`:''}${steps.length?`<section class="layne-activity-detail-section"><h3>Completed steps</h3><ol class="layne-activity-steps">${steps.map(step=>`<li>${step.timestamp?`<time>${esc(stamp(step.timestamp))}</time>`:''}<p>${esc(typeof step==='string'?step:(step.type||'Completed step').replaceAll('_',' ').replaceAll('.',' '))}</p>${step.details?`<div class="layne-activity-facts">${esc(detailText(step.details))}</div>`:''}</li>`).join('')}</ol></section>`:''}<section class="layne-activity-detail-section"><h3>Result details</h3><div class="layne-activity-facts">${esc(detailText(Object.fromEntries(Object.entries(d).filter(([k])=>!['description','steps'].includes(k)))))||'The completion and its trigger were recorded successfully.'}</div></section><p class="layne-activity-expiry">Automatically deletes ${esc(stamp(item.expires_at))}.</p>`;
    if(!dialog.open)dialog.showModal();
  }catch(error){if(version===generation){status(error?.status===404?'This activity has expired or is no longer available.':'Could not load the activity details. Try again.','error');}}
}
root.addEventListener('click',e=>{const button=e.target.closest('[data-completion-id]');if(button)detail(button.dataset.completionId);});
$('layneActivityClose').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{detailId=null;$('layneActivityDetail').replaceChildren();});
$('layneActivityMore').onclick=async()=>{const b=$('layneActivityMore');b.disabled=true;try{await load({older:true});}catch{status('Could not load earlier completions. Try again.','error');}finally{b.disabled=false;}};
window.addEventListener('roggy-page',e=>{if(e.detail?.page==='ai')start();else stop();});
window.addEventListener('roggy-auth',e=>{if(!e.detail?.signedIn)stop({clear:true});else start();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else start();});
window.addEventListener('focus',()=>start());
start();
