export const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));
export function hsvToRgb(h, s, v = 1) {
  const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}
export function rgbToHsv(rgb) {
  const [r,g,b] = rgb.map(n=>clamp(n/255)), max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h = !d ? 0 : max===r ? ((g-b)/d)%6 : max===g ? (b-r)/d+2 : (r-g)/d+4;
  return {h:(h*60+360)%360,s:max ? d/max : 0,v:max};
}
export function pointToColor(x,y) {
  const s=clamp(Math.hypot(x,y));
  const h=(180-Math.atan2(y,x)*180/Math.PI+360)%360;
  return {h,s,rgb:hsvToRgb(h,s),x:Math.cos((180-h)*Math.PI/180)*s,y:Math.sin((180-h)*Math.PI/180)*s};
}
export function colorToPoint(h,s) { return {x:Math.cos((180-h)*Math.PI/180)*s,y:Math.sin((180-h)*Math.PI/180)*s}; }
export function kelvinToRgb(kelvin) {
  const t=kelvin/100;
  return [t<=66?255:329.698727446*(t-60)**-.1332047592,t<=66?99.4708025861*Math.log(t)-161.1195681661:288.1221695283*(t-60)**-.0755148492,t>=66?255:t<=19?0:138.5177312231*Math.log(t-10)-305.0447927307].map(n=>Math.round(clamp(n,0,255)));
}
export const rgbHex = rgb => '#'+rgb.map(n=>Math.round(clamp(n,0,255)).toString(16).padStart(2,'0')).join('');

// All modes share one lane per bulb. Keep only the newest unsent value, and
// never let an older color finish after a newer temperature (or power) command.
export class LatestLightQueue {
  constructor(send,{interval=90,onResult=()=>{},onIdle=()=>{}}={}) {
    Object.assign(this,{send,interval,onResult,onIdle}); this.lanes=new Map(); this.sequence=0;
  }
  put(id,body) {
    let lane=this.lanes.get(id);
    if(!lane){lane={busy:false,pending:null,timer:null,lastSent:0,version:0};this.lanes.set(id,lane);}
    lane.pending={body,version:++this.sequence};lane.version=lane.pending.version;
    this.pump(id,lane);return lane.version;
  }
  async pump(id,lane) {
    if(lane.busy||lane.timer||!lane.pending)return;
    const delay=Math.max(0,this.interval-(Date.now()-lane.lastSent));
    if(delay){lane.timer=setTimeout(()=>{lane.timer=null;this.pump(id,lane)},delay);return;}
    const item=lane.pending;lane.pending=null;lane.busy=true;lane.lastSent=Date.now();
    try{const result=await this.send(id,item.body);if(result?.success===false)throw new Error(result?.error?.message||result?.error_code||'Light rejected the command');this.onResult(id,item,null,item.version===lane.version,result);}
    catch(error){this.onResult(id,item,error,item.version===lane.version);}
    finally{lane.busy=false;if(lane.pending)this.pump(id,lane);else if(!this.active)this.onIdle();}
  }
  get active(){return [...this.lanes.values()].some(lane=>lane.busy||lane.pending||lane.timer);}
  clear(){for(const lane of this.lanes.values()){clearTimeout(lane.timer);lane.timer=null;lane.pending=null;}}
}

export function mergeLightPatch(previous,body){
  const patch={...previous};
  if(body.action==='power')patch.power=body.value;
  if(body.action==='brightness'){patch.brightness=body.value;patch.power=body.value?'on':'off';}
  if(body.action==='color'){patch.color={...body.color};delete patch.kelvin;patch.power='on';}
  if(body.action==='color_temperature'){patch.kelvin=body.kelvin;delete patch.color;patch.power='on';}
  if(patch.power==='on'&&patch.brightness===0)delete patch.brightness;
  return patch;
}

// One HTTP request carries every affected bulb. Only the latest absolute
// settings survive a drag; transient failures retain and retry those settings.
export class LatestLightBatchQueue {
  constructor(send,{interval=250,onAccepted=()=>{},onFailure=()=>{},onRetry=()=>{},onIdle=()=>{}}={}){
    Object.assign(this,{send,interval,onAccepted,onFailure,onRetry,onIdle});
    this.pending=new Map();this.desired=new Map();this.versions=new Map();this.attempts=new Map();
    this.busy=false;this.timer=null;this.lastSent=0;this.sequence=0;this.generation=0;
  }
  put(id,body){
    const desired=mergeLightPatch(this.desired.get(id)||{},body),version=++this.sequence;
    this.desired.set(id,desired);this.versions.set(id,version);this.attempts.set(id,0);
    this.pending.set(id,{id,desired:{...desired},version});
    this.schedule();return version;
  }
  schedule(delay=0){
    if(this.busy||this.timer||!this.pending.size)return;
    const wait=Math.max(delay,this.interval-(Date.now()-this.lastSent),0);
    this.timer=setTimeout(()=>{this.timer=null;this.pump()},wait);
  }
  async pump(){
    if(this.busy||!this.pending.size)return;
    const items=[...this.pending.values()],generation=this.generation;
    this.pending.clear();this.busy=true;this.lastSent=Date.now();let retryDelay=0;
    try{
      const result=await this.send({request_id:globalThis.crypto?.randomUUID?.()||`light-${Date.now()}-${this.sequence}`,updates:items.map(item=>({device_id:item.id,...item.desired}))});
      if(result?.success===false)throw Object.assign(Error(result.error?.message||'Light update rejected'),{status:400});
      if(generation===this.generation)this.onAccepted(items,result);
    }catch(error){
      if(generation!==this.generation)return;
      const retryable=!error.status||[408,429].includes(error.status)||error.status>=500;
      for(const item of items){
        if(this.versions.get(item.id)!==item.version)continue;
        const attempts=(this.attempts.get(item.id)||0)+1;this.attempts.set(item.id,attempts);
        if(retryable&&attempts<=6){this.pending.set(item.id,item);retryDelay=Math.max(retryDelay,Math.min(4000,300*2**(attempts-1)));this.onRetry(item,error);}
        else{this.desired.delete(item.id);this.onFailure(item,error);}
      }
    }finally{
      this.busy=false;
      if(generation===this.generation){if(this.pending.size)this.schedule(retryDelay);else this.onIdle();}
      else if(this.pending.size)this.schedule();
    }
  }
  confirm(id,version){if(this.versions.get(id)===version)this.desired.delete(id);}
  current(id,version){return this.versions.get(id)===version;}
  get active(){return this.busy||!!this.timer||this.pending.size>0;}
  clear(){this.generation++;clearTimeout(this.timer);this.timer=null;this.pending.clear();this.desired.clear();this.versions.clear();this.attempts.clear();}
}
