const api=window.roggyLights,$=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const zone='America/Chicago',dateKey=value=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const time=value=>new Intl.DateTimeFormat(undefined,{timeZone:zone,hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date(value));
const date=value=>new Intl.DateTimeFormat(undefined,{timeZone:zone,month:'short',day:'numeric',year:'numeric'}).format(new Date(value));
const reason=r=>r.reason==='initiated_by_user'?'Initiated by user':'Scheduled / automatic';
let state={routines:[],runs:[]},selected=null,tab='today',history=[],total=0,loading=false,generation=0,guidePage=0;
const dialog=document.createElement('dialog');dialog.id='routineDialog';dialog.className='routine-dialog';dialog.setAttribute('aria-labelledby','routineTitle');document.body.append(dialog);
const eventDialog=document.createElement('dialog');eventDialog.id='routineEventDialog';eventDialog.className='routine-dialog routine-event-dialog';eventDialog.setAttribute('aria-labelledby','routineEventTitle');document.body.append(eventDialog);
function msg(text){$('routinesStatus').textContent=text;const d=$('routineActionStatus');if(d)d.textContent=text;}
async function load({silent=false}={}){
  if(loading)return;loading=true;const v=generation;
  if(!silent)msg('Loading your routines…');
  try{const data=await api.fetch('/routines');if(v!==generation)return;state={routines:data.routines||[],runs:data.runs||[]};render();if(selected){const item=state.routines.find(r=>r.id===selected.id);if(item)selected=item;const runButton=dialog.querySelector('[data-routine-action=run]'),cancelButton=dialog.querySelector('[data-routine-action=cancel]');if(runButton)runButton.disabled=!api.allowed()||selected.running||!selected.enabled;if(cancelButton)cancelButton.disabled=!api.allowed()||!selected.running;if(tab==='today')renderPanel();}if(!silent)msg('');}
  catch(e){if(v===generation)msg(`Routines unavailable: ${e.message||'Check the connection to Layne.'}${state.routines.length?' Showing the last loaded information.':''}`);}
  finally{loading=false;}
}
const guides=[
 ['Your day, already in motion','Open a routine to see today’s runs, the exact steps and announcements, and a longer explanation. Run now starts it immediately. Cancel stops the remaining steps of an ongoing run.','The Good Morning routine saves the briefing used that morning, including your Spanish word, its example and pronunciation, plus the detailed weather forecast. Open any saved run to revisit those details.'],
 ['A history you can follow','History keeps each run’s local date and time, its result, and why it started: scheduled / automatic or initiated by user. Select a run to see accepted commands and confirmed device changes in order.','Completed actions remain in history after cancellation. Run history begins when recording is enabled; older announcements that were never saved are unavailable. All dates and times use America/Chicago.']
];
function render(){
  const root=$('routinesList');if(!root)return;
  const today=dateKey(Date.now()),guide=guides[guidePage];
  root.innerHTML=`<section class="routine-guide"><div class="routine-guide-top"><span class="eyebrow">A QUICK GUIDE</span><span>${guidePage+1} / 2</span></div><h3>${guide[0]}</h3><p>${guide[1]}</p><p>${guide[2]}</p><div class="routine-guide-pages"><button type="button" data-guide-page="0" aria-pressed="${guidePage===0}">Overview</button><button type="button" data-guide-page="1" aria-pressed="${guidePage===1}">History & details</button></div></section><div class="routine-section-heading"><h3>Your routines</h3><span>${state.routines.length} configured</span></div>${state.routines.map(r=>{
    const runs=state.runs.filter(x=>x.routine_id===r.id&&dateKey(x.started_at)===today),last=runs[0];
    return `<article class="routine-card"><button type="button" class="routine-card-open" data-routine-open="${esc(r.id)}"><span class="routine-symbol" aria-hidden="true">${r.id==='morning_routine'?'☀':r.id==='wake_up'?'◔':r.id==='good_night'?'☾':'⌂'}</span><span><b>${esc(r.name)}</b><small>${esc(r.summary)}</small></span><span class="routine-chevron" aria-hidden="true">›</span></button><div class="routine-card-state"><span class="routine-state" data-state="${r.running?'running':r.enabled?'ready':'disabled'}">${r.running?'Running now':r.enabled?'Ready':'Disabled'}</span><span>${last?`${runs.length} run${runs.length===1?'':'s'} today · ${time(last.started_at)}`:'No recorded runs today'}</span></div><div class="routine-card-actions"><button type="button" class="primary" data-routine-action="run" data-routine-id="${esc(r.id)}" ${!api.allowed()||r.running||!r.enabled?'disabled':''}>Run now</button><button type="button" class="secondary" data-routine-action="cancel" data-routine-id="${esc(r.id)}" ${!api.allowed()||!r.running?'disabled':''}>Cancel routine</button></div></article>`;
  }).join('')||'<p class="quiet-state">No routines have been reported by Layne.</p>'}`;
}
function open(id){
  selected=state.routines.find(r=>r.id===id);if(!selected)return;tab='today';history=[];
  dialog.innerHTML=`<div class="routine-dialog-body"><div class="routine-dialog-head"><div><span class="eyebrow">ROUTINE</span><h2 id="routineTitle">${esc(selected.name)}</h2></div><button type="button" class="routine-close" data-routine-close aria-label="Close routine">✕</button></div><p class="routine-summary">${esc(selected.summary)}</p><div class="routine-card-actions"><button type="button" class="primary" data-routine-action="run" data-routine-id="${esc(id)}" ${selected.running||!selected.enabled?'disabled':''}>Run now</button><button type="button" class="secondary" data-routine-action="cancel" data-routine-id="${esc(id)}" ${!selected.running?'disabled':''}>Cancel routine</button></div><p id="routineActionStatus" class="status" role="status"></p><div class="routine-tabs" role="tablist" aria-label="Routine details"><button type="button" role="tab" data-routine-tab="today">Today</button><button type="button" role="tab" data-routine-tab="history">History</button><button type="button" role="tab" data-routine-tab="about">About</button></div><section id="routinePanel"></section></div>`;
  renderPanel();if(!dialog.open)dialog.showModal();
}
function runRows(runs){return runs.map(r=>`<button type="button" class="routine-run" data-routine-run="${esc(r.id)}" data-routine-id="${esc(r.routine_id)}"><span class="routine-run-mark" aria-hidden="true">${r.status==='completed'?'✓':r.status==='running'?'◷':r.status==='cancelled'?'×':'·'}</span><span><b>${date(r.started_at)} · ${time(r.started_at)}</b><small>${reason(r)}</small></span><span class="routine-state" data-state="${esc(r.status)}">${esc(r.status)}</span></button>`).join('');}
function renderPanel(){
  if(!selected||!$('routinePanel'))return;
  dialog.querySelectorAll('[data-routine-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.routineTab===tab);b.setAttribute('aria-selected',String(b.dataset.routineTab===tab));});
  const root=$('routinePanel');root.setAttribute('role','tabpanel');
  if(tab==='about'){root.innerHTML=`<div class="routine-about"><h3>How ${esc(selected.name)} works</h3>${selected.description.map(p=>`<p>${esc(p)}</p>`).join('')}<h4>What is recorded</h4><p>Each run records its trigger, progress, accepted service calls, and result. Device confirmations appear separately when available. Selecting a run opens its full event timeline.</p></div>`;return;}
  const runs=tab==='history'?history:state.runs.filter(r=>r.routine_id===selected.id&&dateKey(r.started_at)===dateKey(Date.now()));
  root.innerHTML=`<div class="routine-section-heading"><h3>${tab==='history'?'Run history':'Today’s activity'}</h3><span>${tab==='history'?total:runs.length} run${(tab==='history'?total:runs.length)===1?'':'s'}</span></div>${runs.length?runRows(runs):`<div class="routine-empty"><b>${tab==='today'?'No runs recorded today':'No saved history yet'}</b><p>${tab==='today'?'When this routine runs, select it here to see exactly what happened.':'New runs will be saved automatically, including their trigger and actions.'}</p></div>`}${tab==='history'&&history.length<total?'<button class="secondary routine-load-more" type="button" data-history-more>Load earlier runs</button>':''}`;
}
async function loadHistory(append=false){
  const id=selected?.id,v=generation;if(!id)return;
  try{const data=await api.fetch(`/routines/${encodeURIComponent(id)}/history?limit=100&offset=${append?history.length:0}`);if(selected?.id!==id||v!==generation)return;history=append?[...history,...data.runs]:data.runs;total=data.total;renderPanel();}
  catch(e){msg(`Could not load routine history: ${e.message}`);}
}
async function action(id,operation,button){
  if(!api.allowed())return msg('Sign in to control routines.');button.disabled=true;
  try{const result=await api.fetch(`/routines/${encodeURIComponent(id)}/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});msg(result.message||'Routine updated.');await load({silent:true});if(selected?.id===id){dialog.querySelector('[data-routine-action=run]').disabled=selected.running;dialog.querySelector('[data-routine-action=cancel]').disabled=!selected.running;}}
  catch(e){msg(`Could not ${operation==='run'?'start':'cancel'} the routine: ${e.message}`);button.disabled=false;}
}
function weatherMarkup(w){
  if(!w)return '<p class="quiet-state">Weather was not captured for this run.</p>';
  const c=w.current||{},d=w.today||{},value=(n,unit)=>n==null?'Unavailable':esc(n)+unit;
  const rows=[['Temperature',value(c.temperature_f,' °F')],['Feels like',value(c.apparent_temperature_f,' °F')],['High / low',`${value(d.high_f,'°')} / ${value(d.low_f,'°')}`],['Rain chance',value(d.precipitation_probability_percent,'%')],['Rain amount',value(d.precipitation_sum_inches,' in')],['Wind',value(c.wind_mph,' mph')],['UV now',value(c.uv_index,'')],['UV peak',value(d.uv_index_max,'')]];
  return `<p>${esc(w.location||'Home')} · ${esc(c.condition||w.status||'Weather')}</p><dl class="routine-weather-grid">${rows.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>${w.detailed_speech?`<p>${esc(w.detailed_speech)}</p>`:''}${c.observed_at?`<small>Observed ${esc(c.observed_at)} · ${esc(w.source||'')}</small>`:''}`;
}
function wordMarkup(w){if(!w)return '<p class="quiet-state">A Spanish word was not captured for this run.</p>';return `<div class="routine-word"><span class="eyebrow">SPANISH WORD OF THE DAY</span><h3 lang="es">${esc(w.word)}</h3><p>${esc(w.part_of_speech||'')} · ${esc(w.meaning||w.definition||'')}</p><dl><dt>Spelling</dt><dd lang="es">${esc(w.spelling||[...w.word].join(' · '))}</dd><dt>Pronunciation</dt><dd>${esc(w.pronunciation||'Listen in Spanish')} <button type="button" class="routine-pronounce secondary" data-pronounce="${esc(w.word)}">Listen</button></dd><dt>Example sentence</dt><dd lang="es">${esc(w.example||w.example_sentence||'Unavailable')}</dd>${w.example_translation?`<dt>English</dt><dd>${esc(w.example_translation)}</dd>`:''}</dl></div>`;}
function stepText(step){const d=step.details||{};if(step.type==='routine.service_accepted'||step.type==='routine.service_requested'){const action=`${d.domain||''}.${d.service||''}`;return `${step.type.endsWith('accepted')?'Accepted':'Requested'}: ${action}${d.entity_id?' · '+(Array.isArray(d.entity_id)?d.entity_id.join(', '):d.entity_id):''}${d.message?' · Layne said: '+d.message:''}`;}if(step.type==='routine.state_confirmed')return `${d.attributes?.friendly_name||d.entity_id}: ${d.previous_state||'unknown'} → ${d.state}${d.attributes?.brightness!=null?' · brightness '+Math.round(d.attributes.brightness/255*100)+'%':''}`;if(step.type==='routine.briefing')return 'Morning briefing and its source data saved';return (step.type||'Update').replace(/[_\.]/g,' ').toLowerCase()+(d.reason?' · '+d.reason:'');}
async function openRun(routineId,id){
  const v=generation;try{const run=await api.fetch(`/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(id)}`);if(v!==generation||!dialog.open)return;
    const steps=run.steps||[],brief=steps.find(s=>s.type==='routine.briefing')?.details;
    const speech=[...new Set(steps.flatMap(s=>s.type==='routine.briefing'?[s.details.generated_speech]:s.details?.message&&s.details.domain==='notify'?[s.details.message]:[]).filter(Boolean))];
    eventDialog.innerHTML=`<div class="routine-dialog-body"><div class="routine-dialog-head"><div><span class="eyebrow">SAVED RUN</span><h2 id="routineEventTitle">${esc(selected?.name||routineId)}</h2></div><button type="button" class="routine-close" data-event-close aria-label="Close run details">✕</button></div><div class="routine-run-meta"><b>${date(run.started_at)} · ${time(run.started_at)}</b><span>${reason(run)} · ${esc(run.status)}</span>${run.ended_at?`<small>Finished ${time(run.ended_at)}</small>`:''}</div><section class="routine-run-section"><h3>What Layne said</h3>${speech.length?speech.map(s=>`<blockquote>${esc(s)}</blockquote>`).join(''):'<p class="quiet-state">No spoken message was recorded for this run.</p>'}</section>${routineId==='morning_routine'?`<section class="routine-run-section">${wordMarkup(brief?.spanish_word)}</section><section class="routine-run-section"><h3>Weather that morning</h3>${weatherMarkup(brief?.weather)}</section>`:''}<section class="routine-run-section"><h3>What happened</h3><ol class="routine-timeline">${steps.map(s=>`<li><time>${time(s.timestamp)}</time><div><b>${esc(stepText(s))}</b><details><summary>Step details</summary><pre>${esc(JSON.stringify(s.details,null,2))}</pre></details></div></li>`).join('')||'<li>No additional steps were captured.</li>'}</ol></section></div>`;
    if(!eventDialog.open)eventDialog.showModal();
  }catch(e){msg(`Could not open this run: ${e.message}`);}
}
document.addEventListener('click',e=>{
  const close=e.target.closest('[data-routine-close]');if(close)return dialog.close();if(e.target.closest('[data-event-close]'))return eventDialog.close();
  const guide=e.target.closest('[data-guide-page]');if(guide){guidePage=Number(guide.dataset.guidePage);return render();}
  const b=e.target.closest('[data-routine-open]');if(b)return open(b.dataset.routineOpen);
  const a=e.target.closest('[data-routine-action]');if(a)return action(a.dataset.routineId,a.dataset.routineAction,a);
  const t=e.target.closest('[data-routine-tab]');if(t){tab=t.dataset.routineTab;renderPanel();if(tab==='history')loadHistory();return;}
  if(e.target.closest('[data-history-more]'))return loadHistory(true);
  const r=e.target.closest('[data-routine-run]');if(r)return openRun(r.dataset.routineId,r.dataset.routineRun);
  const pronounce=e.target.closest('[data-pronounce]');if(pronounce){if(!window.speechSynthesis){pronounce.textContent='Audio unavailable';return;}const utterance=new SpeechSynthesisUtterance(pronounce.dataset.pronounce);utterance.lang='es-ES';utterance.rate=.78;speechSynthesis.cancel();speechSynthesis.speak(utterance);}
});
dialog.addEventListener('close',()=>{selected=null;eventDialog.close();});
window.addEventListener('roggy-page',e=>{if(e.detail?.page==='routines')load();});
window.addEventListener('roggy-auth',e=>{generation++;if(!e.detail?.signedIn){state={routines:[],runs:[]};history=[];dialog.close();eventDialog.close();$('routinesList').replaceChildren();$('routinesStatus').textContent='Sign in to view your routines.';}});
setInterval(()=>{if(!document.hidden&&!$('routinesPage').hidden)load({silent:true});},5000);
