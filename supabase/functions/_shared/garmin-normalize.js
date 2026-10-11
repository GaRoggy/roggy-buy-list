// Shared, privacy-minimizing Garmin export normalization for the browser,
// Edge Function and local FIT importer. Raw source files are never persisted.
export const GARMIN_METRIC_UNITS = Object.freeze({
  steps: 'count', step_goal: 'count', distance: 'meters', floors_climbed: 'floors',
  active_calories: 'kcal', resting_calories: 'kcal', calories: 'kcal',
  intensity_minutes: 'minutes', sedentary_minutes: 'minutes', active_minutes: 'minutes',
  heart_rate: 'bpm', resting_heart_rate: 'bpm', minimum_heart_rate: 'bpm', maximum_heart_rate: 'bpm',
  hrv: 'ms', hrv_weekly_average: 'ms', stress: 'score', body_battery: 'score',
  body_battery_high: 'score', body_battery_low: 'score', body_battery_charge: 'points', body_battery_drain: 'points',
  sleep_duration: 'seconds', deep_sleep_duration: 'seconds', light_sleep_duration: 'seconds',
  rem_sleep_duration: 'seconds', awake_duration: 'seconds', sleep_score: 'score',
  training_readiness: 'score', training_load: 'score', recovery_time: 'seconds',
  respiration: 'breaths/min', spo2: 'percent', vo2_max: 'ml/kg/min', fitness_age: 'years',
  activity_duration: 'seconds', activity_heart_rate: 'bpm', pace: 'seconds/km',
  elevation_gain: 'meters', cadence: 'steps/min', training_effect: 'score',
});

const CSV_METRICS = [
  ['steps','count',['steps','step_count','total_steps']], ['step_goal','count',['step_goal','steps_goal']],
  ['distance','meters',['distance','total_distance']], ['floors_climbed','floors',['floors','floors_climbed','floors_ascended']],
  ['active_calories','kcal',['active_calories','active_calories_burned']], ['resting_calories','kcal',['resting_calories','resting_calories_burned']],
  ['calories','kcal',['calories','total_calories','calories_burned','total_calories_burned']],
  ['intensity_minutes','minutes',['intensity_minutes','moderate_intensity_minutes','vigorous_intensity_minutes']],
  ['sedentary_minutes','minutes',['sedentary_minutes','sedentary_time']], ['active_minutes','minutes',['active_minutes','active_time']],
  ['heart_rate','bpm',['heart_rate','average_heart_rate','avg_heart_rate']],
  ['resting_heart_rate','bpm',['resting_heart_rate','resting_hr','rhr']],
  ['minimum_heart_rate','bpm',['minimum_heart_rate','min_heart_rate','min_hr']],
  ['maximum_heart_rate','bpm',['maximum_heart_rate','max_heart_rate','max_hr']],
  ['hrv','ms',['hrv','hrv_ms','last_night_hrv','last_night_average_hrv']],
  ['hrv_weekly_average','ms',['hrv_weekly_average','weekly_average_hrv']], ['stress','score',['stress','average_stress','stress_level']],
  ['body_battery','score',['body_battery','body_battery_level']], ['body_battery_high','score',['body_battery_high','body_battery_max']],
  ['body_battery_low','score',['body_battery_low','body_battery_min']], ['body_battery_charge','points',['body_battery_charge','body_battery_charged']],
  ['body_battery_drain','points',['body_battery_drain','body_battery_drained']],
  ['sleep_duration','seconds',['sleep_duration','total_sleep','total_sleep_time']],
  ['deep_sleep_duration','seconds',['deep_sleep_duration','deep_sleep']], ['light_sleep_duration','seconds',['light_sleep_duration','light_sleep']],
  ['rem_sleep_duration','seconds',['rem_sleep_duration','rem_sleep']], ['awake_duration','seconds',['awake_duration','awake_time']],
  ['sleep_score','score',['sleep_score','overall_sleep_score']], ['training_readiness','score',['training_readiness','readiness']],
  ['training_load','score',['training_load','acute_training_load']], ['recovery_time','seconds',['recovery_time','recovery_time_seconds']],
  ['respiration','breaths/min',['respiration','respiration_rate','breathing_rate']], ['spo2','percent',['spo2','pulse_ox','oxygen_saturation']],
  ['vo2_max','ml/kg/min',['vo2_max','vo2max']], ['fitness_age','years',['fitness_age']],
];

const FIELD_LIMITS = Object.freeze({
  steps:[0,100000], step_goal:[0,100000], distance:[0,1000000], floors_climbed:[0,1000],
  active_calories:[0,20000], resting_calories:[0,10000], calories:[0,30000], intensity_minutes:[0,1440],
  sedentary_minutes:[0,1440], active_minutes:[0,1440], heart_rate:[20,250], resting_heart_rate:[20,200],
  minimum_heart_rate:[20,250], maximum_heart_rate:[20,250], hrv:[0,500], hrv_weekly_average:[0,500],
  stress:[0,100], body_battery:[0,100], body_battery_high:[0,100], body_battery_low:[0,100],
  body_battery_charge:[0,200], body_battery_drain:[0,200], sleep_duration:[0,86400], deep_sleep_duration:[0,86400],
  light_sleep_duration:[0,86400], rem_sleep_duration:[0,86400], awake_duration:[0,86400], sleep_score:[0,100],
  training_readiness:[0,100], training_load:[0,100000], recovery_time:[0,1209600], respiration:[1,100],
  spo2:[50,100], vo2_max:[5,100], fitness_age:[1,130], activity_duration:[1,604800],
  activity_heart_rate:[20,250], pace:[30,3600], elevation_gain:[0,100000], cadence:[0,400], training_effect:[0,10],
});
const ACTIVITY_ONLY_METRICS = new Set(['distance','calories','heart_rate','minimum_heart_rate','maximum_heart_rate']);

export function parseCsv(text, { maxRows = 50000 } = {}) {
  if (typeof text !== 'string') throw new Error('INVALID_CSV');
  const rows = [], row = [], cell = [];
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell.push('"'); i++; }
      else if (ch === '"') quoted = false;
      else cell.push(ch);
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === ',') { row.push(cell.join('')); cell.length = 0; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.join('')); cell.length = 0;
      if (row.some(value => value.trim())) rows.push(row.splice(0)); else row.length = 0;
      if (rows.length > maxRows) throw new Error('GARMIN_CSV_TOO_MANY_ROWS');
    } else cell.push(ch);
  }
  if (quoted) throw new Error('GARMIN_CSV_UNCLOSED_QUOTE');
  row.push(cell.join(''));
  if (row.some(value => value.trim())) rows.push(row);
  if (!rows.length || rows.length > maxRows) throw new Error('GARMIN_CSV_EMPTY_OR_TOO_LARGE');
  return rows;
}

function headerKey(value) { return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text || /^(?:-|—|n\/a|na|null|undefined)$/i.test(text)) return null;
  const match = text.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i);
  return match ? Number(text) : null;
}
function durationSeconds(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) return clock[3] === undefined ? Number(clock[1]) * 60 + Number(clock[2]) : Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const words = text.match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i);
  if (words && (words[1] || words[2] || words[3])) return Number(words[1] || 0) * 3600 + Number(words[2] || 0) * 60 + Number(words[3] || 0);
  const n = numeric(text);
  if (n === null) return null;
  const key = headerKey(label);
  if (key.includes('hour') || key.endsWith('_hr')) return n * 3600;
  if (key.includes('minute') || key.endsWith('_min')) return n * 60;
  return n;
}
function metricForHeader(header, activityRow) {
  const key = headerKey(header);
  const base = key.replace(/_(?:mi|mile|miles|km|kilometer|kilometers|meter|meters|sec|seconds|mins|minutes|hours|hr|bpm|kcal|calories)$/, '');
  for (const [metric, unit, aliases] of CSV_METRICS) if (aliases.includes(base) || aliases.includes(key)) return { metric, unit, header: String(header) };
  if (activityRow) {
    if (['duration','total_time','time','elapsed_time','moving_time'].includes(base)) return { metric:'activity_duration', unit:'seconds', header:String(header) };
    if (['avg_speed','average_speed'].includes(base)) return { metric:'speed', unit:'m/s', header:String(header) };
    if (['average_pace','avg_pace','pace'].includes(base)) return { metric:'pace', unit:'seconds/km', header:String(header) };
    if (['average_cadence','avg_cadence','cadence'].includes(base)) return { metric:'cadence', unit:'steps/min', header:String(header) };
    if (['elevation_gain','total_ascent','ascent'].includes(base)) return { metric:'elevation_gain', unit:'meters', header:String(header) };
    if (['aerobic_training_effect','aerobic_te','training_effect','aerobic_effect'].includes(base)) return { metric:'training_effect', unit:'score', header:String(header) };
  }
  return null;
}
function distanceMeters(value, header) {
  const n = numeric(value); if (n === null) return null;
  const key = headerKey(header);
  if (/(?:^|_)(?:mi|mile|miles)(?:_|$)/.test(key)) return n * 1609.344;
  if (/(?:^|_)(?:km|kilometer|kilometers)(?:_|$)/.test(key)) return n * 1000;
  return n;
}
function localParts(timeZone, epoch) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date(epoch));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function localTimestamp(value, timeZone) {
  const raw = String(value ?? '').trim(); if (!raw) return null;
  const explicitZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (explicitZone) { const parsed = new Date(raw); return Number.isNaN(parsed.getTime()) ? null : { date:parsed, resolution:'explicit_offset' }; }
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (!match) return null;
  let [, a, b, c, h='12', min='0', sec='0', ampm] = match;
  let year, month, day;
  if (String(a).length === 4) { year=Number(a); month=Number(b); day=Number(c); }
  else { year=Number(c); month=Number(a); day=Number(b); }
  let hour=Number(h); if (ampm) { if (hour < 1 || hour > 12) return null; hour=hour%12+(ampm.toUpperCase()==='PM'?12:0); }
  const parts={year,month,day,hour,minute:Number(min),second:Number(sec)};
  const desired=Date.UTC(year,month-1,day,hour,Number(min),Number(sec));
  if (!Object.values(parts).every(Number.isFinite) || parts.month<1 || parts.month>12 || parts.day<1 || parts.day>31 || parts.hour>23 || parts.minute>59 || parts.second>59) return null;
  const candidates=new Set();
  for (const delta of [-36,-24,-12,0,12,24,36]) {
    const probe=desired+delta*3600000, shown=localParts(timeZone,probe);
    const offset=Date.UTC(shown.year,shown.month-1,shown.day,shown.hour,shown.minute,shown.second)-probe;
    const candidate=desired-offset, actual=localParts(timeZone,candidate);
    if (Object.keys(parts).every(key=>parts[key]===actual[key])) candidates.add(candidate);
  }
  if (!candidates.size) return null; // Reject nonexistent local times at DST jumps.
  const epochs=[...candidates].sort((x,y)=>x-y);
  return {date:new Date(epochs[0]),resolution:epochs.length>1?'ambiguous_local_time_earlier_occurrence':'local_timezone'};
}
async function hashText(text) {
  const bytes=new TextEncoder().encode(text), digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,24);
}
async function makeMeasurement({metric, value, unit, date, header, rawTimestamp, timeZone, aggregation='observation', timeResolution='explicit_offset', sourceFormat='garmin_export'}) {
  const limits=FIELD_LIMITS[metric];
  if (!limits || !Number.isFinite(value) || value<limits[0] || value>limits[1] || GARMIN_METRIC_UNITS[metric]!==unit) return null;
  const timestamp=date.toISOString();
  // Identify the measurement by its source format, metric and source timestamp,
  // so re-exporting a larger archive still upserts corrections to the same row.
  const identity=await hashText(`${sourceFormat}|health_measurement|${metric}|${timestamp}`);
  return {kind:'health_measurement',external_id:`export:${identity}:${metric}:${timestamp}`,occurred_at:timestamp,status:'processed',
    payload:{metric,value,unit,source_metric:String(header||metric).slice(0,80),source_format:sourceFormat,source_timestamp:String(rawTimestamp||timestamp).slice(0,80),source_timezone:timeZone,aggregation,time_resolution:timeResolution}};
}
function firstValue(row, headers, names) {
  for (const name of names) { const key=headerKey(name), index=headers.findIndex(h=>headerKey(h)===key || headerKey(h).startsWith(key+'_')); if(index>=0 && String(row[index]??'').trim()) return {value:row[index],header:headers[index]}; }
  return null;
}
async function activityRecord({row,headers,rawTimestamp,date,timeZone}) {
  const type=firstValue(row,headers,['activity type','sport','activity']);
  if (!type) return null;
  const fields={};
  const values=[
    ['duration_seconds',['duration','total time','time','elapsed time','moving time'],'duration'],
    ['distance_meters',['distance','total distance'],'distance'], ['calories_kcal',['calories','total calories'],'number'],
    ['average_hr_bpm',['avg hr','average hr','avg heart rate','average heart rate'],'number'],
    ['max_hr_bpm',['max hr','maximum heart rate'],'number'], ['average_speed_mps',['avg speed','average speed'],'number'],
    ['elevation_gain_m',['elevation gain','total ascent','ascent'],'number'], ['avg_cadence',['avg cadence','average cadence'],'number'],
    ['training_effect',['aerobic te','aerobic training effect','training effect'],'number'],
  ];
  const limits={duration_seconds:[1,604800],distance_meters:[0,1000000],calories_kcal:[0,30000],average_hr_bpm:[20,250],max_hr_bpm:[20,250],average_speed_mps:[0,100],elevation_gain_m:[0,100000],avg_cadence:[0,400],training_effect:[0,10]};
  for(const [target,names,kind] of values){ const found=firstValue(row,headers,names); if(!found)continue;
    let val=kind==='duration'?durationSeconds(found.value,found.header):kind==='distance'?distanceMeters(found.value,found.header):numeric(found.value);
    const [minimum,maximum]=limits[target];
    if(val!==null && Number.isFinite(val) && val>=minimum && val<=maximum)fields[target]=val;
  }
  const rawType=String(type.value).trim().toLowerCase();
  const activityType=canonicalActivityType(rawType);
  const start=date.toISOString();
  const providerId=firstValue(row,headers,['activity id','activity identifier','activity reference']);
  const identity=providerId?`activity|${start}|${String(providerId.value).trim()}`:`activity|${start}|${activityType}`;
  const activityKey=await hashText(identity);
  return {kind:'garmin_activity',external_id:`export:${activityKey}:activity:${start}`,occurred_at:start,status:'processed',
    payload:{activity_type:activityType,start_time:start,...fields,source_format:'garmin_export',source_timestamp:String(rawTimestamp||start).slice(0,80),source_timezone:timeZone,gps_included:false}};
}
function canonicalActivityType(value) {
  const raw=String(value||'').toLowerCase();
  const match=raw.match(/run|walk|hike|cycle|bike|swim|strength|cardio|yoga|rowing|ski|elliptical|golf|tennis|soccer|football|basketball|other/);
  return match?.[0]||'other';
}

export async function normalizeGarminCsv(text, { sourceTimezone='UTC' } = {}) {
  if (text.length>8*1024*1024) throw new Error('GARMIN_CSV_TOO_LARGE');
  let timeZone; try { timeZone=Intl.DateTimeFormat('en-US',{timeZone:sourceTimezone}).resolvedOptions().timeZone; } catch { throw new Error('INVALID_TIMEZONE'); }
  const rows=parseCsv(text); if(rows.length<2) return {records:[],warnings:['No data rows found.']};
  const headers=rows[0].map(x=>String(x||'').trim());
  const dateIndex=headers.findIndex(h=>['date','timestamp','start_time','activity_date','start_date','calendar_date','date_time','local_timestamp','timestamp_local'].includes(headerKey(h)));
  if(dateIndex<0) throw new Error('GARMIN_CSV_TIMESTAMP_COLUMN_REQUIRED');
  const output=[], warnings=[];
  for(let rowIndex=1;rowIndex<rows.length;rowIndex++){
    const row=rows[rowIndex]; if(!row.some(x=>String(x||'').trim()))continue;
    const rawTimestamp=row[dateIndex]; const parsed=localTimestamp(rawTimestamp,timeZone);
    if(!parsed){warnings.push(`Row ${rowIndex+1}: unparseable or nonexistent local timestamp.`);continue;}
    const activity=await activityRecord({row,headers,rawTimestamp,date:parsed.date,timeZone});
    if(activity)output.push(activity);
    for(let col=0;col<headers.length;col++){
      const mapping=metricForHeader(headers[col],!!activity); if(!mapping)continue;
      // Activity-summary fields belong to the workout record; do not turn an
      // exercise's heart rate, calories or distance into all-day health data.
      if(activity&&ACTIVITY_ONLY_METRICS.has(mapping.metric))continue;
      let value=mapping.metric.endsWith('_duration')?durationSeconds(row[col],headers[col]):mapping.metric==='distance'?distanceMeters(row[col],headers[col]):numeric(row[col]);
      if(mapping.metric==='activity_duration' && value===null)value=durationSeconds(row[col],headers[col]);
      const aggregation=['steps','distance','calories','active_calories','resting_calories','floors_climbed','intensity_minutes','sedentary_minutes','active_minutes'].includes(mapping.metric)?'daily_total':'observation';
      const record=await makeMeasurement({metric:mapping.metric,value,unit:mapping.unit,date:parsed.date,header:headers[col],rawTimestamp,timeZone,aggregation,timeResolution:parsed.resolution});
      if(record)output.push(record);
    }
    if(output.length>10000)throw new Error('GARMIN_IMPORT_RECORD_LIMIT');
  }
  const unique=new Map(); for(const record of output)unique.set(`${record.kind}:${record.external_id}`,record);
  return {records:[...unique.values()],warnings:warnings.slice(0,100)};
}

function fitDate(value) { const date=value instanceof Date?value:new Date(value); return Number.isNaN(date.getTime())?null:date; }
async function fitMeasurement(metric, value, unit, timestamp, sourceMetric, timeZone, aggregation='observation') {
  const date=fitDate(timestamp); if(!date)return null;
  return makeMeasurement({metric,value,unit,date,header:sourceMetric,rawTimestamp:date.toISOString(),timeZone,aggregation,timeResolution:'fit_utc',sourceFormat:'garmin_fit'});
}
async function fitActivity(item, timeZone) {
  const start=fitDate(item.startTime||item.timestamp); if(!start)return null;
  const seconds=(key)=>Number.isFinite(item[key])?item[key]:undefined;
  const payload={activity_type:canonicalActivityType(item.sport||item.subSport||'other'),start_time:start.toISOString(),source_format:'garmin_fit',source_timestamp:start.toISOString(),source_timezone:timeZone,gps_included:false};
  const fields={duration_seconds:seconds('totalElapsedTime'),distance_meters:seconds('totalDistance'),calories_kcal:seconds('totalCalories'),
    average_hr_bpm:seconds('avgHeartRate'),max_hr_bpm:seconds('maxHeartRate'),average_speed_mps:seconds('avgSpeed'),
    elevation_gain_m:seconds('totalAscent'),avg_cadence:seconds('avgCadence'),training_effect:seconds('totalTrainingEffect')};
  const limits={duration_seconds:[1,604800],distance_meters:[0,1000000],calories_kcal:[0,30000],average_hr_bpm:[20,250],max_hr_bpm:[20,250],average_speed_mps:[0,100],elevation_gain_m:[0,100000],avg_cadence:[0,400],training_effect:[0,10]};
  for(const [key,value]of Object.entries(fields)){const [minimum,maximum]=limits[key];if(value!==undefined&&value>=minimum&&value<=maximum)payload[key]=value;}
  const activityKey=await hashText(`fit_activity|${start.toISOString()}|${payload.activity_type}`);
  return {kind:'garmin_activity',external_id:`export:${activityKey}:activity:${start.toISOString()}`,occurred_at:start.toISOString(),status:'processed',payload};
}
async function sleepStageMetrics(messages, timeZone) {
  const rows=(messages||[]).map(item=>({date:fitDate(item.timestamp),stage:String(item.sleepLevel||'').toLowerCase()})).filter(item=>item.date).sort((a,b)=>a.date-b.date);
  const duration={deep_sleep_duration:0,light_sleep_duration:0,rem_sleep_duration:0,awake_duration:0};
  const stageMap={deep:'deep_sleep_duration',light:'light_sleep_duration',rem:'rem_sleep_duration',awake:'awake_duration'};
  for(let i=0;i<rows.length-1;i++){
    const seconds=(rows[i+1].date-rows[i].date)/1000, target=stageMap[rows[i].stage];
    if(target && seconds>0 && seconds<=10800)duration[target]+=seconds;
  }
  const stamp=rows.at(-1)?.date; if(!stamp)return [];
  const records=[];
  for(const [metric,value]of Object.entries(duration))if(value>0)records.push(await fitMeasurement(metric,value,'seconds',stamp,'sleepLevel.duration',timeZone));
  const asleep=duration.deep_sleep_duration+duration.light_sleep_duration+duration.rem_sleep_duration;
  if(asleep>0)records.push(await fitMeasurement('sleep_duration',asleep,'seconds',stamp,'sleepLevel.total_staged_sleep',timeZone));
  return records.filter(Boolean);
}

export async function normalizeGarminFitMessages(messages, { sourceTimezone='UTC' } = {}) {
  let timeZone; try { timeZone=Intl.DateTimeFormat('en-US',{timeZone:sourceTimezone}).resolvedOptions().timeZone; } catch { timeZone='UTC'; }
  const rows=[];
  const add=async(metric,value,unit,stamp,field,aggregation='observation')=>{const record=await fitMeasurement(metric,value,unit,stamp,field,timeZone,aggregation);if(record)rows.push(record);};
  for(const item of messages.monitoringMesgs||[]){
    const stamp=item.timestamp||item.localTimestamp;
    // The FIT monitoring message accumulates counters by activity type. Keep
    // interval heart-rate observations, but leave daily totals to explicit
    // wellness CSV summaries until those subtype counters can be combined.
    if(Number.isFinite(item.heartRate))await add('heart_rate',item.heartRate,'bpm',stamp,'monitoring.heartRate');
  }
  for(const item of messages.monitoringHrDataMesgs||[])if(Number.isFinite(item.restingHeartRate))await add('resting_heart_rate',item.restingHeartRate,'bpm',item.timestamp,'monitoringHrData.restingHeartRate');
  for(const item of messages.hrvValueMesgs||[])if(Number.isFinite(item.value))await add('hrv',item.value,'ms',item.timestamp,'hrvValue.value');
  for(const item of messages.hrvStatusSummaryMesgs||[]){
    if(Number.isFinite(item.lastNightAverage))await add('hrv',item.lastNightAverage,'ms',item.timestamp,'hrvStatusSummary.lastNightAverage');
    if(Number.isFinite(item.weeklyAverage))await add('hrv_weekly_average',item.weeklyAverage,'ms',item.timestamp,'hrvStatusSummary.weeklyAverage');
  }
  for(const item of messages.respirationRateMesgs||[])if(Number.isFinite(item.respirationRate))await add('respiration',item.respirationRate,'breaths/min',item.timestamp,'respirationRate.respirationRate');
  for(const item of messages.sleepAssessmentMesgs||[])if(Number.isFinite(item.overallSleepScore))await add('sleep_score',item.overallSleepScore,'score',item.timestamp,'sleepAssessment.overallSleepScore');
  rows.push(...await sleepStageMetrics(messages.sleepLevelMesgs,timeZone));
  for(const item of messages.sessionMesgs||[]){const record=await fitActivity(item,timeZone);if(record)rows.push(record);}
  const unique=new Map();for(const record of rows)unique.set(`${record.kind}:${record.external_id}`,record);
  return [...unique.values()];
}

export function validateImportedRecords(input) {
  if(!Array.isArray(input)||input.length>10000)throw new Error('GARMIN_IMPORT_RECORD_LIMIT');
  const allowedActivity=new Set(['activity_type','start_time','duration_seconds','distance_meters','calories_kcal','average_hr_bpm','max_hr_bpm','average_speed_mps','elevation_gain_m','avg_cadence','training_effect','source_format','source_timestamp','source_timezone','gps_included']);
  return input.map(record=>{
    if(!record||!['health_measurement','garmin_activity'].includes(record.kind)||typeof record.external_id!=='string'||record.external_id.length>180||!/^export:[a-f0-9]{24}:(?:[a-z0-9_.:-]{1,120})$/i.test(record.external_id))throw new Error('INVALID_GARMIN_RECORD');
    const date=new Date(record.occurred_at);if(Number.isNaN(date.getTime())||date.toISOString()!==record.occurred_at)throw new Error('INVALID_GARMIN_TIMESTAMP');
    const payload=record.payload;if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('INVALID_GARMIN_PAYLOAD');
    if(record.kind==='health_measurement'){
      const metric=payload.metric,limits=FIELD_LIMITS[metric];
      if(!limits||payload.unit!==GARMIN_METRIC_UNITS[metric]||!Number.isFinite(payload.value)||payload.value<limits[0]||payload.value>limits[1])throw new Error('INVALID_GARMIN_MEASUREMENT');
      if(!['observation','daily_total','interval_total'].includes(payload.aggregation||'observation'))throw new Error('INVALID_GARMIN_AGGREGATION');
      const safe={metric,value:payload.value,unit:payload.unit,source_metric:String(payload.source_metric||metric).slice(0,80),source_format:String(payload.source_format||'garmin_export').slice(0,24),source_timestamp:String(payload.source_timestamp||record.occurred_at).slice(0,80),source_timezone:String(payload.source_timezone||'UTC').slice(0,80),aggregation:payload.aggregation||'observation'};
      if(payload.time_resolution)safe.time_resolution=String(payload.time_resolution).slice(0,48);
      return {...record,status:'processed',payload:safe};
    }
    if(Object.keys(payload).some(key=>!allowedActivity.has(key))||payload.gps_included!==false||typeof payload.activity_type!=='string')throw new Error('INVALID_GARMIN_ACTIVITY');
    const activityLimits={duration_seconds:[1,604800],distance_meters:[0,1000000],calories_kcal:[0,30000],average_hr_bpm:[20,250],max_hr_bpm:[20,250],average_speed_mps:[0,100],elevation_gain_m:[0,100000],avg_cadence:[0,400],training_effect:[0,10]};
    for(const [key,[minimum,maximum]]of Object.entries(activityLimits)){
      const value=payload[key];if(value!==undefined&&(!Number.isFinite(value)||value<minimum||value>maximum))throw new Error('INVALID_GARMIN_ACTIVITY_FIELD');
    }
    const safe={activity_type:payload.activity_type.slice(0,80),start_time:String(payload.start_time||record.occurred_at).slice(0,80),source_format:String(payload.source_format||'garmin_export').slice(0,24),source_timestamp:String(payload.source_timestamp||record.occurred_at).slice(0,80),source_timezone:String(payload.source_timezone||'UTC').slice(0,80),gps_included:false};
    for(const key of allowedActivity)if(payload[key]!==undefined&&!['activity_type','start_time','source_format','source_timestamp','source_timezone','gps_included'].includes(key))safe[key]=payload[key];
    return {...record,status:'processed',payload:safe};
  });
}
