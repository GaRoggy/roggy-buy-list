import { analyzeFinance } from './finance.mjs';
import { dailyHealth, correlation } from './health.mjs';

export function dayKey(value,zone) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
}
export function calendarAnalysis(records,now,zone) {
  const today=dayKey(now,zone), tomorrow=new Date(today+'T12:00:00Z');tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  const next=tomorrow.toISOString().slice(0,10);
  const events=records.filter(r=>r.status!=='deleted'&& !r.payload.attendees?.some(a=>a.self&&a.response==='declined'));
  const onDay=(r,day)=>r.payload.all_day ? r.payload.start<=day&&r.payload.end>day : dayKey(r.payload.start,zone)<=day&&dayKey(new Date(Date.parse(r.payload.end)-1),zone)>=day;
  const todays=events.filter(r=>onDay(r,today)).sort((a,b)=>a.payload.start.localeCompare(b.payload.start));
  const timed=todays.filter(r=>!r.payload.all_day).sort((a,b)=>Date.parse(a.payload.start)-Date.parse(b.payload.start));
  const conflicts=[];let occupied=0,end=0;
  for(let i=0;i<timed.length;i++) {
    const a=timed[i],s=Date.parse(a.payload.start),e=Date.parse(a.payload.end);
    occupied+=Math.max(0,e-Math.max(s,end));end=Math.max(e,end);
    for(let j=i+1;j<timed.length;j++) {
      const b=timed[j];if(Date.parse(b.payload.start)>=e)break;
      conflicts.push({record_ids:[a.id,b.id],reason:'These timed calendar events overlap.'});
    }
  }
  return {today:todays,tomorrow:events.filter(r=>onDay(r,next)),conflicts,scheduled_hours:occupied/3600000,
    busy_day:occupied>=6*3600000,
    starting_soon:timed.filter(r=>Date.parse(r.payload.start)>=now.getTime()&&Date.parse(r.payload.start)-now.getTime()<=30*60000),
    preparation:todays.filter(r=>/\b(exam|interview|flight|presentation)\b/i.test(r.payload.title)).map(r=>({record_id:r.id,reason:'The event title suggests preparation may be useful.'}))};
}
export function linkContexts(emails,transactions) {
  const links=[];
  for(const email of emails) {
    const ref=email.payload.order_information;
    if(!ref||ref.length<6)continue;
    for(const t of transactions) {
      if(t.payload.name?.split(/[^a-zA-Z0-9-]+/).some(s=>s.toLowerCase()===ref.toLowerCase())) {
        links.push({external_id:`order:${email.id}:${t.id}`,record_ids:[email.id,t.id],context_type:'order',
          evidence:{order_reference:ref},confidence:'candidate',explanation:'An exact order reference appears in both sources; verify before treating them as the same purchase.'});
      }
    }
  }
  return links;
}
export function buildBrief({calendar=[],emails=[],transactions=[],measurements=[],reminders=[],sources=[]},now=new Date(),zone='America/Chicago') {
  const date=dayKey(now,zone),schedule=calendarAnalysis(calendar,now,zone);
  const recent=emails.filter(r=>r.status!=='deleted'&&r.payload.dashboard&&Date.parse(r.occurred_at)>=now.getTime()-14*86400000);
  const finance=analyzeFinance(transactions,date.slice(0,7));
  const health=dailyHealth(measurements,zone);
  const sleepStress=correlation(health.map(d=>({date:d.date,x:d.metrics.sleep_duration?.value,y:d.metrics.stress?.value})));
  const alerts=[...schedule.conflicts.map(c=>({...c,key:`conflict:${[...c.record_ids].sort().join(':')}`,type:'calendar_conflict',severity:'NOTICE'})),
    ...recent.filter(r=>r.payload.urgency==='IMPORTANT').map(r=>({key:`email:${r.id}`,type:'important_email',severity:'IMPORTANT',record_ids:[r.id],reason:r.payload.reason})),
    ...finance.alerts.filter(a=>a.record_ids.some(id=>transactions.some(t=>(t.id||t.external_id)===id&&Date.parse(t.occurred_at)>=now.getTime()-7*86400000)))];
  return {schema_version:1,date,time_zone:zone,generated_at:now.toISOString(),
    sections:{TODAY:schedule,IMPORTANT:recent.filter(r=>r.payload.category!=='shipping'),MONEY:finance,
      HEALTH:{daily:health.filter(d=>d.date===date),sleep_stress_association:sleepStress},REMINDERS:reminders,
      PACKAGES:recent.filter(r=>r.payload.category==='shipping')},
    source_freshness:sources.map(s=>({id:s.id,kind:s.kind,enabled:s.enabled,last_success_at:s.last_success_at,last_attempt_at:s.last_attempt_at,error_code:s.error_code,
      stale:!s.last_success_at||Date.parse(s.last_success_at)<now.getTime()-s.interval_seconds*2000})),
    context_links:linkContexts(recent,transactions),alerts};
}
export async function syncBrief(source,env,store) {
  const [calendar,emails,transactions,measurements,sources,reminders,previousAlerts]=await Promise.all([
    store.records('calendar_event'),store.records('email'),store.records('transaction'),store.records('health_measurement'),
    store.api(`monitor_sources?user_id=eq.${env.MONITOR_USER_ID}`),
    store.api(`reminders?user_id=eq.${env.MONITOR_USER_ID}&completed=eq.false&cancelled_at=is.null&order=start_at&limit=1000`),store.records('alert')]);
  const now=new Date(),payload=buildBrief({calendar,emails,transactions,measurements,sources,reminders},now,env.MONITOR_TIMEZONE);
  const records=[{kind:'brief',external_id:payload.date,occurred_at:now.toISOString(),payload}];
  const active=new Set(payload.alerts.map(a=>a.key));
  for(const a of payload.alerts)records.push({kind:'alert',external_id:a.key,occurred_at:now.toISOString(),payload:{...a,expires_at:new Date(now.getTime()+86400000).toISOString()}});
  for(const old of previousAlerts.filter(r=>r.source_id===source.id&&!active.has(r.external_id)))records.push({kind:'alert',external_id:old.external_id,status:'deleted',occurred_at:old.occurred_at,payload:old.payload});
  for(const link of payload.context_links)records.push({kind:'context_link',external_id:link.external_id,occurred_at:now.toISOString(),payload:link});
  return{records,cursor:{generated_at:now.toISOString()}};
}
