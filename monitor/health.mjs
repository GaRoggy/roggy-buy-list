import { MonitorError } from './core.mjs';
export const metricUnits = Object.freeze({sleep_duration:'seconds',sleep_score:'score',resting_heart_rate:'bpm',heart_rate:'bpm',
  hrv:'ms',stress:'score',body_battery:'score',steps:'count',calories:'kcal',intensity_minutes:'minutes',
  respiration:'breaths/min',spo2:'percent',training_load:'score',recovery_time:'seconds'});
// Internal schema only. Provider-specific mappings require approved Garmin docs.
export function measurement({external_id,metric,value,unit,timestamp,source_metric}) {
  if (!external_id || !(metric in metricUnits) || unit!==metricUnits[metric] || !Number.isFinite(value) || !Number.isFinite(Date.parse(timestamp))) {
    throw new MonitorError('INVALID_HEALTH_MEASUREMENT');
  }
  return {kind:'health_measurement',external_id,occurred_at:new Date(timestamp).toISOString(),
    payload:{metric,value,unit,source_metric:source_metric || null}};
}
export function correlation(pairs, minimum=30) {
  const unique = new Map();
  for(const p of pairs) if(p.date && Number.isFinite(p.x) && Number.isFinite(p.y)) unique.set(p.date,p);
  const rows=[...unique.values()], n=rows.length;
  if(n<Math.max(30,minimum)) return {status:'insufficient_data',sample_size:n,minimum_samples:Math.max(30,minimum)};
  const mx=rows.reduce((s,p)=>s+p.x,0)/n,my=rows.reduce((s,p)=>s+p.y,0)/n;
  const xx=rows.reduce((s,p)=>s+(p.x-mx)**2,0), yy=rows.reduce((s,p)=>s+(p.y-my)**2,0);
  if(!xx || !yy)return{status:'no_variation',sample_size:n};
  const r=rows.reduce((s,p)=>s+(p.x-mx)*(p.y-my),0)/Math.sqrt(xx*yy);
  return {status:'descriptive_only',sample_size:n,pearson_r:Math.max(-1,Math.min(1,r)),
    explanation:'Observed association, not evidence of causation. Repeated daily measures may be autocorrelated; no significance claim is made.'};
}
export function dailyHealth(records,timeZone) {
  const days=new Map();
  for(const r of records) {
    const p=r.payload;if(!Number.isFinite(p.value))continue;
    const date=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.occurred_at));
    const day=days.get(date)||{date,metrics:{},provenance:[]};
    const key=p.metric,old=day.metrics[key];
    // Latest value is not mislabeled as a daily sum/mean (e.g. cumulative steps).
    if(!old || r.occurred_at>old.timestamp)day.metrics[key]={value:p.value,unit:p.unit,timestamp:r.occurred_at,aggregation:'latest_observation'};
    day.provenance.push(r.id||r.external_id);days.set(date,day);
  }
  return [...days.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export async function syncGarmin() {
  throw new MonitorError('GARMIN_APPROVED_API_ACCESS_REQUIRED',{terminal:true});
}
