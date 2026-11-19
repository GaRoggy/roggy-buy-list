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
