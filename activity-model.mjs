export const REASONS=Object.freeze({test:'Test',user_initiated:'User initiated',automated:'Automated'});
export const RETENTION_MS=9*86400000;
export function completionTime(item){return Date.parse(item.completed_at);}
export function expiryTime(item){return Date.parse(item.expires_at)||completionTime(item)+RETENTION_MS;}
export function mergeCompletions(previous,incoming,now=Date.now()){
  const byId=new Map(previous.map(item=>[item.id,item]));
  for(const item of incoming){if(item&&typeof item.id==='string'&&REASONS[item.reason]&&Number.isFinite(completionTime(item)))byId.set(item.id,item);}
  return [...byId.values()].filter(item=>expiryTime(item)>now).sort((a,b)=>completionTime(b)-completionTime(a)||(b.sequence||0)-(a.sequence||0));
}
export function detailText(value,depth=0){
  if(depth>5)return '';
  if(value==null)return '';
  if(Array.isArray(value))return value.slice(0,100).map(v=>detailText(v,depth+1)).filter(Boolean).join('\n');
  if(typeof value==='object')return Object.entries(value).filter(([k])=>!/token|secret|password|authorization|credential|cookie/i.test(k)).map(([k,v])=>`${k.replaceAll('_',' ')}: ${detailText(v,depth+1)}`).join('\n');
  return String(value);
}
