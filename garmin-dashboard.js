const sb=window.roggySupabase;
const OWNER_ID=window.ROGGY_OWNER_USER_ID;
const GARMIN_CONTROL='garmin-control';
const GARMIN_SOURCE_IMPORT='official-export-import';
const GARMIN_METRICS=[
  ['steps','Steps'],['body_battery','Body Battery'],['heart_rate','Last recorded heart rate'],
  ['resting_heart_rate','Resting heart rate'],['sleep_duration','Last recorded sleep'],['sleep_score','Sleep score'],
  ['hrv','HRV'],['stress','Stress'],['calories','Calories burned'],['training_readiness','Training readiness'],
];
const ACTIVITY_API_SOURCE='approved-api';
const GARMIN_CHARTS=[
  ['resting_heart_rate','Resting heart rate','bpm','garminChartRestingHeartRate'],
  ['sleep_duration','Sleep duration','seconds','garminChartSleepDuration'],['sleep_score','Sleep score','score','garminChartSleepScore'],
  ['hrv','HRV','ms','garminChartHrv'],['body_battery','Body Battery','score','garminChartBodyBattery'],
  ['stress','Stress','score','garminChartStress'],['steps','Steps','count','garminChartSteps'],
  ['calories','Calories burned','kcal','garminChartCalories'],['training_load','Training load','score','garminChartTrainingLoad'],
];
const chartInstances=new Map();
let healthRecords=[],activityRecords=[],sourceRows=[],loading=false;
const $=id=>document.getElementById(id);
function esc(value=''){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
function setStatus(message){const el=$('garminPageStatus');if(el)el.textContent=message||''}
function isOwner(session){return !!session?.user&&session.user.id===OWNER_ID}
function safeZone(){
  const zone=healthRecords.find(row=>row.payload?.source_timezone)?.payload.source_timezone;
  try{return Intl.DateTimeFormat('en-US',{timeZone:zone||'America/Chicago'}).resolvedOptions().timeZone}catch{return 'America/Chicago'}
}
function dateKey(value,zone=safeZone()){
  const date=new Date(value);if(Number.isNaN(date.getTime()))return '';
  try{return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date)}catch{return date.toISOString().slice(0,10)}
}
function formatTimestamp(value){
  if(!value)return 'Time not recorded';const date=new Date(value);if(Number.isNaN(date.getTime()))return 'Time not recorded';
  return date.toLocaleString([],{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
}
function relativeAge(value){
  if(!value)return 'No synchronized records yet.';const age=Math.max(0,Date.now()-new Date(value).getTime());
  if(!Number.isFinite(age))return 'Freshness unavailable.';
  const hours=Math.floor(age/3600000);if(hours<1)return 'Recorded less than an hour ago.';
  if(hours<36)return `Latest record ${hours} hour${hours===1?'':'s'} ago.`;
  const days=Math.floor(hours/24);return `Latest record ${days} day${days===1?'':'s'} ago; this data may be stale.`;
}
function latestMetric(metric){
  return healthRecords.filter(row=>row.payload?.metric===metric&&Number.isFinite(row.payload.value))
    .sort((a,b)=>String(b.occurred_at).localeCompare(String(a.occurred_at)))[0]||null;
}
function formatMetric(metric,value){
  if(!Number.isFinite(value))return '—';
  if(metric.endsWith('_duration'))return `${(value/3600).toFixed(1)} h`;
  if(metric==='distance')return value>=1000?`${(value/1000).toFixed(1)} km`:`${Math.round(value)} m`;
  if(metric==='steps')return Math.round(value).toLocaleString();
  if(metric==='calories'||metric==='active_calories'||metric==='resting_calories')return `${Math.round(value).toLocaleString()} kcal`;
  const unit=({heart_rate:'bpm',resting_heart_rate:'bpm',hrv:'ms',body_battery:'',stress:'',sleep_score:'',training_readiness:'',training_load:'',respiration:' breaths/min',spo2:'%',steps:'',fitness_age:' yrs'})[metric];
  const digits=Math.abs(value)<10&&value%1!==0?1:0;
  return `${Number(value.toFixed(digits)).toLocaleString()}${unit===undefined?'':unit?` ${unit}`:''}`;
}
function metricDetail(metric,row){
  if(!row)return 'Not present in imported data';
  const source=row.payload?.source_format==='garmin_fit'?'FIT export':row.payload?.source_format==='garmin_export'?'Garmin export':'Garmin record';
  return `${formatTimestamp(row.occurred_at)} · ${source}`;
}
function renderMetricCards(){
  const root=$('garminMetricCards');if(!root)return;
  root.innerHTML=GARMIN_METRICS.map(([metric,label])=>{
    const row=latestMetric(metric),value=row?formatMetric(metric,row.payload.value):'—';
    const cardLabel=metric==='steps'&&row&&dateKey(row.occurred_at)===dateKey(new Date())?"Today's steps":metric==='steps'?'Latest recorded steps':label;
    return `<article class="garmin-metric-card"><span>${esc(cardLabel)}</span><b>${esc(value)}</b><small>${esc(metricDetail(metric,row))}</small></article>`;
  }).join('');
}
function metricUnit(metric){return GARMIN_CHARTS.find(item=>item[0]===metric)?.[2]||''}
function dailySeries(metric,days){
  const now=new Date(),cutoff=new Date(now.getTime()-days*86400000),zone=safeZone(),byDay=new Map();
  for(const record of healthRecords){
    const payload=record.payload||{};if(payload.metric!==metric||!Number.isFinite(payload.value))continue;
    const date=new Date(record.occurred_at);if(Number.isNaN(date.getTime())||date<cutoff)continue;
    const key=dateKey(date,zone);if(!key)continue;
    const list=byDay.get(key)||[];list.push({value:payload.value,timestamp:record.occurred_at,aggregation:payload.aggregation||'observation'});byDay.set(key,list);
  }
  return [...byDay.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,list])=>{
    list.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
    const interval=list.filter(item=>item.aggregation==='interval_total');
    const value=interval.length?interval.reduce((sum,item)=>sum+item.value,0):list.at(-1).value;
    return {date,value};
  });
}
function renderCharts(){
  const days=Number($('garminRange')?.value)||30;
  for(const [metric,label,unit,id] of GARMIN_CHARTS){
    const canvas=$(id),card=canvas?.closest('.garmin-chart-card'),empty=card?.querySelector('.garmin-chart-empty');if(!canvas)continue;
    chartInstances.get(id)?.destroy();chartInstances.delete(id);
    const points=dailySeries(metric,days);canvas.hidden=!points.length;if(empty)empty.hidden=!!points.length;
    if(!points.length||typeof Chart==='undefined')continue;
    const duration=unit==='seconds';
    const chart=new Chart(canvas,{type:'line',data:{labels:points.map(point=>point.date),datasets:[{
      label:`${label}${duration?' (hours)':unit?` (${unit})`:''}`,data:points.map(point=>duration?point.value/3600:point.value),
      borderColor:'#7c3aed',backgroundColor:'rgba(124,58,237,.12)',fill:true,tension:.28,borderWidth:2,
      pointRadius:points.length>40?0:2.5,pointHoverRadius:5,
    }]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:context=>` ${context.dataset.label}: ${Number(context.parsed.y).toLocaleString(undefined,{maximumFractionDigits:1})}`}}},
      scales:{x:{grid:{display:false},ticks:{maxTicksLimit:7,color:'#82758f',font:{size:9}}},y:{grid:{color:'rgba(116,92,143,.12)'},ticks:{color:'#82758f',font:{size:9},callback:value=>Number(value).toLocaleString(undefined,{maximumFractionDigits:1})}}}}});
    chartInstances.set(id,chart);
  }
}
function formatWorkout(record){
  const p=record.payload||{},date=p.start_time||record.occurred_at,type=String(p.activity_type||'activity').replaceAll('_',' ');
  const details=[];if(Number.isFinite(p.duration_seconds))details.push(`${Math.round(p.duration_seconds/60)} min`);
  if(Number.isFinite(p.distance_meters))details.push(p.distance_meters>=1000?`${(p.distance_meters/1000).toFixed(1)} km`:`${Math.round(p.distance_meters)} m`);
  if(Number.isFinite(p.calories_kcal))details.push(`${Math.round(p.calories_kcal)} kcal`);
  return {type:type.replace(/\b\w/g,char=>char.toUpperCase()),date:formatTimestamp(date),details:details.join(' · ')||'Activity summary imported'};
}
function renderWorkouts(){
  const root=$('garminWorkoutList');if(!root)return;
  if(!activityRecords.length){root.innerHTML='<div class="garmin-empty-state">No workout summaries are available yet. Garmin activity CSV files or FIT activity summaries can be imported.</div>';return;}
  root.innerHTML=activityRecords.slice(0,50).map((record,index)=>{const item=formatWorkout(record);return `<button class="garmin-workout-card" type="button" data-workout-index="${index}"><span><b>${esc(item.type)}</b><span>${esc(item.date)}</span><small>${esc(item.details)}</small></span><strong>Details&nbsp; →</strong></button>`}).join('');
  root.querySelectorAll('[data-workout-index]').forEach(button=>button.addEventListener('click',()=>openWorkout(activityRecords[Number(button.dataset.workoutIndex)])));
}
function openWorkout(record){
  const root=$('garminActivityDetail'),dialog=$('garminActivityDialog');if(!root||!dialog)return;
  const p=record.payload||{},item=formatWorkout(record),fields=[
    ['Duration',Number.isFinite(p.duration_seconds)?`${Math.round(p.duration_seconds/60)} minutes`:null],
    ['Distance',Number.isFinite(p.distance_meters)?formatMetric('distance',p.distance_meters):null],
    ['Calories',Number.isFinite(p.calories_kcal)?`${Math.round(p.calories_kcal)} kcal`:null],
    ['Average heart rate',Number.isFinite(p.average_hr_bpm)?`${Math.round(p.average_hr_bpm)} bpm`:null],
    ['Maximum heart rate',Number.isFinite(p.max_hr_bpm)?`${Math.round(p.max_hr_bpm)} bpm`:null],
    ['Average speed',Number.isFinite(p.average_speed_mps)?`${(p.average_speed_mps*3.6).toFixed(1)} km/h`:null],
    ['Elevation gain',Number.isFinite(p.elevation_gain_m)?`${Math.round(p.elevation_gain_m)} m`:null],
    ['Training effect',Number.isFinite(p.training_effect)?p.training_effect.toFixed(1):null],
  ].filter(([,value])=>value!==null);
  root.className='garmin-activity-detail';root.innerHTML=`<span class="eyebrow">WORKOUT SUMMARY</span><h3>${esc(item.type)}</h3><p>${esc(item.date)} · ${esc(p.source_format||'Garmin record')}</p><div class="garmin-activity-values">${fields.map(([label,value])=>`<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')||'<p class="garmin-empty-state">No additional workout fields were provided.</p>'}</div><p>Precise GPS routes and coordinates are not shown.</p>`;
  dialog.showModal();
}
function renderConnection(){
  const status=$('garminConnectionStatus'),freshness=$('garminFreshness'),sync=$('garminSyncNow'),remove=$('garminDeleteData');if(!status)return;
  const apiSources=sourceRows.filter(source=>source.kind==='garmin'&&source.external_id===ACTIVITY_API_SOURCE);
  const importSource=sourceRows.find(source=>source.kind==='garmin'&&source.external_id===GARMIN_SOURCE_IMPORT);
  const apiEnabled=apiSources.some(source=>source.enabled&&source.config?.api_sync_enabled===true);
  const latest=[...healthRecords,...activityRecords].map(row=>row.occurred_at).filter(Boolean).sort().at(-1);
  if(apiEnabled)status.textContent='An automatic Garmin source is enabled';
  else if(importSource||healthRecords.length||activityRecords.length)status.textContent='Export import is ready · no automatic Garmin connection';
  else status.textContent='Not connected · approved Garmin API access is required for automatic sync';
  freshness.textContent=latest?`${relativeAge(latest)} Last recorded: ${formatTimestamp(latest)}.`:'No Garmin records imported yet.';
  if(sync){sync.disabled=!apiEnabled;sync.title=apiEnabled?'Queue a manual Garmin sync':'Automatic sync needs approved Garmin API access';}
  if(remove)remove.disabled=!sourceRows.some(source=>source.kind==='garmin')&&!healthRecords.length&&!activityRecords.length;
  const successful=sourceRows.filter(source=>source.kind==='garmin'&&source.last_success_at).map(source=>source.last_success_at).sort().at(-1);
  const history=$('garminSyncHistory');if(history)history.textContent=successful?`Last successful import or sync: ${formatTimestamp(successful)}.`:'No completed import or automatic sync is recorded.';
}
async function loadGarminDashboard(){
  if(loading)return;loading=true;setStatus('Loading private Garmin records…');
  try{
    if(!sb){setStatus('The Roggy database client is unavailable.');return;}
    const {data:{session}}=await sb.auth.getSession();
    if(!isOwner(session)){healthRecords=[];activityRecords=[];sourceRows=[];renderMetricCards();renderCharts();renderWorkouts();renderConnection();setStatus('Sign in with the Roggy owner account to view private Garmin data.');return;}
    const cutoff=new Date(Date.now()-90*86400000).toISOString();
    const [healthResult,activityResult,sourceResult]=await Promise.all([
      sb.from('monitor_records').select('id,kind,external_id,occurred_at,synced_at,status,payload').eq('user_id',session.user.id).eq('kind','health_measurement').eq('status','processed').gte('occurred_at',cutoff).order('occurred_at',{ascending:false}).limit(6000),
      sb.from('monitor_records').select('id,kind,external_id,occurred_at,synced_at,status,payload').eq('user_id',session.user.id).eq('kind','garmin_activity').eq('status','processed').order('occurred_at',{ascending:false}).limit(200),
      sb.from('monitor_sources').select('id,kind,external_id,enabled,interval_seconds,last_attempt_at,last_success_at,records_processed,error_code,config').eq('user_id',session.user.id).eq('kind','garmin').limit(20),
    ]);
    const error=healthResult.error||activityResult.error||sourceResult.error;if(error)throw error;
    healthRecords=Array.isArray(healthResult.data)?healthResult.data:[];
    activityRecords=Array.isArray(activityResult.data)?activityResult.data:[];
    sourceRows=Array.isArray(sourceResult.data)?sourceResult.data:[];
    renderMetricCards();renderCharts();renderWorkouts();renderConnection();
    setStatus(healthRecords.length||activityRecords.length?'':'No Garmin records are available yet. Import a Garmin CSV or extracted FIT export to begin.');
  }catch(error){setStatus(error?.message==='Failed to fetch'?'Garmin data could not be reached. Check the private Supabase connection.':'Garmin data could not be loaded. Sign in again or check the Roggy database connection.');}
  finally{loading=false;}
}
async function invokeControl(body){
  const {data:{session}}=await sb.auth.getSession();if(!isOwner(session))throw new Error('Sign in with the Roggy owner account first.');
  const {data,error}=await sb.functions.invoke(GARMIN_CONTROL,{body});
  if(error){
    if(error.context?.status===404)return {error_code:'GARMIN_CONTROLS_NOT_DEPLOYED'};
    let payload=null;try{payload=await error.context?.json?.()}catch{}
    return {error_code:payload?.error_code||'GARMIN_CONTROL_UNAVAILABLE'};
  }
  return data||{};
}
async function importCsv(file){
  if(!file)return;if(file.size>6*1024*1024){setStatus('Choose a CSV smaller than 6 MB.');return;}
  setStatus('Validating the selected CSV…');
  try{
    const result=await invokeControl({action:'import-csv',csv:await file.text(),source_timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'});
    if(result.error_code){setStatus(result.error_code==='GARMIN_CONTROLS_NOT_DEPLOYED'?'The Garmin controls are not deployed to Supabase yet.':result.error_code==='GARMIN_APPROVED_API_ACCESS_REQUIRED'?'Automatic Garmin sync needs approved Garmin API access.':result.error_code==='GARMIN_IMPORT_RETRY_SAFE'?'The import did not finish. Select the same CSV again to safely complete it; already-saved rows are deduplicated.':'The CSV import could not be completed.');return;}
    setStatus(`Imported ${Number(result.imported||0).toLocaleString()} normalized records from the CSV.`);await loadGarminDashboard();
  }catch{setStatus('The CSV import could not be completed. Check the file and the private Supabase connection.');}
}
async function syncGarminNow(){
  setStatus('Checking Garmin sync availability…');
  const result=await invokeControl({action:'sync-now'});
  if(result.error_code){setStatus(result.error_code==='GARMIN_CONTROLS_NOT_DEPLOYED'?'The Garmin controls are not deployed to Supabase yet.':result.error_code==='GARMIN_APPROVED_API_ACCESS_REQUIRED'?'Automatic Garmin sync needs approved Garmin API access.':'A Garmin sync could not be queued.');return;}
  setStatus(result.status==='already_queued'?'A Garmin sync is already queued.':'A Garmin sync has been queued.');
}
async function deleteGarminData(){
  if(!confirm('Delete all Garmin records and sync history stored in Roggy Lists? Local Garmin authorization tokens are not revoked by this action.'))return;
  setStatus('Deleting stored Garmin records…');
  const result=await invokeControl({action:'delete-all',confirmation:'DELETE ALL GARMIN DATA'});
  if(result.error_code){setStatus(result.error_code==='GARMIN_CONTROLS_NOT_DEPLOYED'?'The Garmin controls are not deployed to Supabase yet.':'Garmin data could not be deleted.');return;}
  healthRecords=[];activityRecords=[];sourceRows=[];renderMetricCards();renderCharts();renderWorkouts();renderConnection();setStatus('Stored Garmin records and sync history were deleted. Local authorization was not revoked.');
}
function bindGarminControls(){
  $('garminRange')?.addEventListener('change',renderCharts);
  $('garminImportCsv')?.addEventListener('click',()=>$('garminCsvFile')?.click());
  $('garminCsvFile')?.addEventListener('change',async event=>{await importCsv(event.target.files?.[0]);event.target.value='';});
  $('garminSyncNow')?.addEventListener('click',()=>syncGarminNow().catch(()=>setStatus('A Garmin sync could not be queued.')));
  $('garminDeleteData')?.addEventListener('click',()=>deleteGarminData().catch(()=>setStatus('Garmin data could not be deleted.')));
  $('garminActivityClose')?.addEventListener('click',()=>$('garminActivityDialog')?.close());
}
bindGarminControls();
window.addEventListener('roggy-page',event=>{if(event.detail?.page==='health')loadGarminDashboard();});
sb?.auth?.onAuthStateChange?.(()=>{if(!$('healthPage')?.hidden)loadGarminDashboard();});
