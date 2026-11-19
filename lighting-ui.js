import {clamp,hsvToRgb,rgbToHsv,pointToColor,colorToPoint,kelvinToRgb,rgbHex,LatestLightQueue} from './lighting-model.mjs';

const api=window.roggyLights, $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon={bulb:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 18h6m-5 3h4M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/></svg>',color:'<span class="spectrum-icon"></span>',tint:'<span class="tint-icon"></span>'};
const key=t=>[t.kind,t.room||'',t.category||'',t.id||''].join('|');
const parse=k=>{const [kind,room,category,id]=k.split('|');return {kind,room,category,id}};
const lights=t=>api.devices().filter(d=>d.type==='light'||d.device_class==='light'||d.capabilities?.includes('brightness')).filter(d=>t.kind==='device'?d.device_id===t.id:api.roomId(d)===t.room&&(t.kind!=='group'||api.category(d)===t.category));
const label=t=>t.kind==='device'?(lights(t)[0]?.friendly_name||t.id):`${api.roomName(t.room)}${t.kind==='group'?' · '+api.label(t.category):' · All lights'}`;
const available=(ds,cap)=>ds.filter(d=>api.usable(d)&&d.capabilities?.includes(cap));
let target=null, parent=null, mode='color', dragging=false, syncTimer=null;
const remembered=new Map();
const observed=new Map();
const queue=new LatestLightQueue((id,body)=>api.fetch(`/devices/${encodeURIComponent(id)}/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{
  onResult(id,item,error,current){if(!current)return;api.settled(id,error);if(error)status(`Couldn’t update ${api.devices().find(d=>d.device_id===id)?.friendly_name||'light'}: ${error.message}`);},
  onIdle(){if($('lightControlStatus')?.textContent.startsWith('Updating')||$('deviceStatus')?.textContent.startsWith('Updating'))status('Lights updated.');clearTimeout(syncTimer);syncTimer=setTimeout(()=>api.refresh(),700);}
});
function status(text){const out=$('lightControlStatus');if(out)out.textContent=text;const main=$('deviceStatus');if(main)main.textContent=text;}
function command(t,body){
  if(!api.allowed())return status('Sign in to control your lights.');
  const cap=body.action==='color'?'color':body.action==='color_temperature'?'color_temperature':body.action==='brightness'?'brightness':'power';
  const ds=lights(t),supported=available(ds,cap);
  if(!supported.length)return status('These lights are unavailable or do not support this control.');
  for(const d of supported){api.optimistic(d.device_id,body);queue.put(d.device_id,body);}
  const skipped=ds.length-supported.length;
  status(`Updating ${supported.length} light${supported.length===1?'':'s'}${skipped?` · ${skipped} unavailable or unsupported`:''}…`);
  sync();
}
function controls(t){
  const ds=lights(t),id=key(t),on=ds.some(d=>api.power(d)==='on'),dim=available(ds,'brightness'),values=dim.map(api.brightness).filter(n=>n!=null),brightness=values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length):0,locked=!api.allowed();
  return `<div class="light-quick-controls"><button type="button" class="light-switch ${on?'is-on':''}" role="switch" aria-checked="${on}" aria-label="${esc(label(t))} power" data-light-power="${esc(id)}" ${locked||!available(ds,'power').length?'disabled':''}><span></span></button><span class="light-power-label">${on?'On':'Off'}</span><label class="light-brightness"><span class="sr-only">${esc(label(t))} brightness</span><input type="range" min="0" max="100" value="${brightness}" data-light-brightness="${esc(id)}" ${locked||!dim.length?'disabled':''}><output>${values.length?brightness+'%':'—'}</output></label></div>`;
}
function groupCard(t){const ds=lights(t),on=ds.filter(d=>api.power(d)==='on').length;return `<article class="light-group-card"><button type="button" class="light-group-open" data-light-open="${esc(key(t))}"><span class="light-bulb-icon">${icon.bulb}</span><span><b>${esc(t.kind==='group'?api.label(t.category):'All lights')}</b><small>${ds.length} light${ds.length===1?'':'s'} · ${on} on</small></span><span class="light-card-chevron" aria-hidden="true">›</span></button>${controls(t)}</article>`;}
function roomMarkup(room){
  const roomId=room.room_id,ds=lights({kind:'room',room:roomId}),groups=[...new Set(ds.map(api.category).filter(Boolean))];
  const others=api.roomDevices(room).filter(d=>!ds.some(l=>l.device_id===d.device_id));
  return `${ds.length?`<div class="light-group-grid">${groupCard({kind:'room',room:roomId})}${groups.map(category=>groupCard({kind:'group',room:roomId,category})).join('')}</div>`:''}${others.length?`<details class="other-room-devices"><summary>Other devices <span>${others.length}</span></summary><div class="device-grid">${others.map(api.deviceCard).join('')}</div></details>`:''}`;
}
function stateFor(t){
  const ds=lights(t),d=ds.find(d=>api.power(d)==='on')||ds[0],a=d?.attributes||{},saved=remembered.get(key(t))||{h:0,s:0,kelvin:2700,x:0,y:0};
  if(!dragging&&!queue.active){
    const rgb=a.rgb_color||a.color_rgb||(a.color&&[a.color.r,a.color.g,a.color.b]);
    if(Array.isArray(a.hs_color)){saved.h=a.hs_color[0];saved.s=a.hs_color[1]/100;}
    else if(Array.isArray(rgb)&&rgb.length===3)Object.assign(saved,rgbToHsv(rgb));
    const k=Number(a.color_temp_kelvin||a.color_temperature_kelvin||a.color_temperature);
    if(k>0)saved.kelvin=k;
  }
  remembered.set(key(t),saved);return saved;
}
function limits(t){const ds=available(lights(t),'color_temperature');return {min:Math.max(2000,...ds.map(d=>Number(d.attributes?.min_color_temp_kelvin)||2000)),max:Math.min(6500,...ds.map(d=>Number(d.attributes?.max_color_temp_kelvin)||6500))};}
function wheelMarkup(id){return `<div class="light-wheel" id="${id}" tabindex="0" role="slider" aria-label="Light color" aria-valuemin="0" aria-valuemax="360"><canvas width="360" height="360" aria-hidden="true"></canvas><span class="wheel-thumb" aria-hidden="true"><span></span></span></div>`;}
const dialog=document.createElement('dialog');dialog.id='lightControlDialog';dialog.className='light-control-dialog';dialog.setAttribute('aria-labelledby','lightControlTitle');document.body.append(dialog);
function open(t,{from=null}={}){
  if(!lights(t).length)return;
  target=t;parent=from;const d=lights(t)[0],last=d?.attributes?.color_mode;mode=['color_temp','color_temperature'].includes(last)?'tint':'color';
  if(!available(lights(t),'color').length)mode='tint';
  dialog.innerHTML=`<div class="light-dialog-content"><div class="light-dialog-head"><div>${parent?'<button type="button" class="light-back" id="lightBack">‹ Group</button>':'<span class="eyebrow">LIGHTING</span>'}<h2 id="lightControlTitle">${esc(label(t))}</h2><p id="lightSelectionMeta"></p></div><button type="button" class="light-close" id="lightClose" aria-label="Close light controls">✕</button></div><div id="lightDialogQuick">${controls(t)}</div><div class="wheel-mode-tabs" role="tablist" aria-label="Light color mode"><button id="lightColorTab" type="button" role="tab" data-wheel-mode="color">${icon.color}<span>Color</span></button><button id="lightTintTab" type="button" role="tab" data-wheel-mode="tint">${icon.tint}<span>White & warmth</span></button></div><div class="light-wheel-stage">${wheelMarkup('deviceColorWheel')}</div><div class="wheel-caption"><span id="lightWheelValue"></span><span id="lightWheelModeLabel"></span></div><p id="lightControlStatus" class="light-control-status" role="status">Drag to change your lights live.</p><section id="lightDialogMembers" class="light-members"></section></div>`;
  $('lightClose').onclick=()=>dialog.close();if(parent)$('lightBack').onclick=()=>open(parent);
  dialog.querySelectorAll('[data-wheel-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.wheelMode;sync(true)});
  attachWheel($('deviceColorWheel'),()=>mode==='color'?stateFor(target):{...stateFor(target),...limits(target)},value=>{
    const s=stateFor(target);Object.assign(s,value);
    if(mode==='color'){command(target,{action:'color',color:Object.fromEntries(['r','g','b'].map((c,i)=>[c,value.rgb[i]]))});}
    else{command(target,{action:'color_temperature',kelvin:value.kelvin});}
    sync();
  },()=>mode);
  sync(true);if(!dialog.open)dialog.showModal();
}
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
dialog.addEventListener('close',()=>{target=null;parent=null;dragging=false;});
function sync(rebuild=false){
  if(!target||!dialog.open&&!rebuild)return;
  const ds=lights(target),s=stateFor(target),range=limits(target),canColor=available(ds,'color').length,canTint=available(ds,'color_temperature').length;
  if(!dragging&&!queue.active){const first=ds.find(d=>api.power(d)==='on')||ds[0],a=first?.attributes||{},signature=JSON.stringify([a.color_mode,a.rgb_color,a.hs_color,a.color_temp_kelvin]);const old=observed.get(key(target));if(!rebuild&&old&&old!==signature)mode=['color_temp','color_temperature'].includes(a.color_mode)?'tint':'color';observed.set(key(target),signature);}
  $('lightColorTab').disabled=!api.allowed()||!canColor;$('lightTintTab').disabled=!api.allowed()||!canTint||range.min>range.max;
  for(const b of dialog.querySelectorAll('[data-wheel-mode]')){const active=b.dataset.wheelMode===mode;b.setAttribute('aria-selected',active);b.classList.toggle('active',active);}
  const wheel=$('deviceColorWheel');wheel.dataset.mode=mode;wheel.setAttribute('aria-disabled',String(!api.allowed()||!(mode==='color'?canColor:canTint)));
  position(wheel,s,mode,range);
  const rgb=mode==='color'?hsvToRgb(s.h,s.s):kelvinToRgb(s.kelvin);
  dialog.style.setProperty('--light-color',rgbHex(rgb));
  $('lightWheelValue').textContent=mode==='color'?rgbHex(rgb).toUpperCase():`${Math.round(s.kelvin)} K`;
  $('lightWheelModeLabel').textContent=mode==='color'?'Full spectrum':'Warm to cool white';
  const modes=new Set(ds.map(d=>d.attributes?.color_mode).filter(Boolean));
  const colors=new Set(ds.map(d=>JSON.stringify([d.attributes?.rgb_color,d.attributes?.hs_color,d.attributes?.color_temp_kelvin])));
  $('lightSelectionMeta').textContent=`${ds.length===1?'Individual bulb':`${ds.length} lights together`}${modes.size>1||colors.size>1?' · Mixed colors; drag to match them':''}`;
  if(!dragging&&!$('lightDialogQuick').contains(document.activeElement)){$('lightDialogQuick').innerHTML=controls(target);}
  if(rebuild&&target.kind!=='device')$('lightDialogMembers').innerHTML=`<div class="light-members-heading"><h3>Individual lights</h3><span>${ds.length}</span></div>${ds.map(d=>`<button type="button" class="light-member" data-light-child="${esc(d.device_id)}"><span class="light-bulb-icon">${icon.bulb}</span><span><b>${esc(d.friendly_name||d.device_id)}</b><small>${esc(api.usable(d)?api.power(d)==='on'?'On · '+(api.brightness(d)??'—')+'%':'Off':'Unavailable')}</small></span><span aria-hidden="true">›</span></button>`).join('')}`;
}
function paint(wheel){
  if(wheel.dataset.painted)return;wheel.dataset.painted='yes';
  const canvas=wheel.querySelector('canvas'),ctx=canvas.getContext('2d'),size=canvas.width,img=ctx.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const p=pointToColor((x-size/2)/(size/2),(y-size/2)/(size/2)),i=(y*size+x)*4;img.data.set([...p.rgb,255],i);}
  ctx.putImageData(img,0,0);
}
function position(wheel,s,mode,range={min:2000,max:6500}){
  paint(wheel);const p=mode==='color'?colorToPoint(s.h,s.s):{x:clamp((s.kelvin-range.min)/(range.max-range.min||1))*2-1,y:0};
  const thumb=wheel.querySelector('.wheel-thumb');thumb.style.left=`${50+p.x*47}%`;thumb.style.top=`${50+p.y*47}%`;
  thumb.style.background=rgbHex(mode==='color'?hsvToRgb(s.h,s.s):kelvinToRgb(s.kelvin));
  thumb.querySelector('span').textContent=mode==='tint'?Math.round(s.kelvin)+'K':'';
  wheel.setAttribute('aria-label',mode==='color'?'Color: left and right adjust hue, up and down adjust saturation':'White temperature');
  wheel.setAttribute('aria-valuemin',mode==='color'?'0':String(range.min));wheel.setAttribute('aria-valuemax',mode==='color'?'360':String(range.max));
  wheel.setAttribute('aria-valuenow',String(Math.round(mode==='color'?s.h:s.kelvin)));wheel.setAttribute('aria-valuetext',mode==='color'?`${Math.round(s.h)} degrees hue, ${Math.round(s.s*100)} percent saturation`:`${Math.round(s.kelvin)} kelvin`);
}
function attachWheel(wheel,getState,onMove,getMode=()=> 'color'){
  let activePointer=null;
  const move=e=>{if(activePointer!==e.pointerId||wheel.getAttribute('aria-disabled')==='true')return;e.preventDefault();const r=wheel.getBoundingClientRect(),x=clamp((e.clientX-r.left)/r.width*2-1,-1,1),y=clamp((e.clientY-r.top)/r.height*2-1,-1,1),s=getState();
    onMove(getMode()==='color'?pointToColor(x,y):{kelvin:Math.round((s.min||2000)+(x+1)/2*((s.max||6500)-(s.min||2000)))});
  };
  wheel.onpointerdown=e=>{if(wheel.getAttribute('aria-disabled')==='true')return;activePointer=e.pointerId;dragging=true;wheel.setPointerCapture(e.pointerId);move(e);};
  wheel.onpointermove=move;
  const end=e=>{if(activePointer!==e.pointerId)return;activePointer=null;dragging=false;sync();};
  wheel.onpointerup=e=>{move(e);end(e)};wheel.onpointercancel=end;wheel.onlostpointercapture=end;
  wheel.onkeydown=e=>{if(wheel.getAttribute('aria-disabled')==='true'||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const s=getState();if(getMode()==='color'){const h=(s.h+(e.key==='ArrowLeft'?-3:e.key==='ArrowRight'?3:0)+360)%360,sat=clamp(s.s+(e.key==='ArrowUp'?.03:e.key==='ArrowDown'?-.03:0));onMove({h,s:sat,rgb:hsvToRgb(h,sat)});}else onMove({kelvin:e.key==='Home'?s.min:e.key==='End'?s.max:clamp(s.kelvin+(['ArrowLeft','ArrowDown'].includes(e.key)?-50:50),s.min,s.max)});};
}
document.addEventListener('click',e=>{
  const openButton=e.target.closest('[data-light-open]');if(openButton)return open(parse(openButton.dataset.lightOpen));
  const child=e.target.closest('[data-light-child]');if(child)return open({kind:'device',id:child.dataset.lightChild},{from:target});
  const power=e.target.closest('[data-light-power]');if(power){const t=parse(power.dataset.lightPower);command(t,{action:'power',value:lights(t).some(d=>api.power(d)==='on')?'off':'on'});api.render();}
});
document.addEventListener('input',e=>{const input=e.target.closest('[data-light-brightness]');if(!input)return;input.nextElementSibling.textContent=input.value+'%';command(parse(input.dataset.lightBrightness),{action:'brightness',value:Number(input.value)});});
document.addEventListener('change',e=>{if(e.target.matches('[data-light-brightness]'))api.render();});
// The settings wheel drives the same palette variables used throughout the app.
const themeWheel=$('appThemeWheel');
const themeState=(()=>{try{return JSON.parse(localStorage.getItem('roggy-custom-color'))||{h:270,s:.72}}catch{return {h:270,s:.72}}})();
function theme(s,persist=false){
  Object.assign(themeState,s);const root=document.documentElement,h=themeState.h,sat=themeState.s*100;
  const vars={'--accent':`hsl(${h} ${sat}% 38%)`,'--accent2':`hsl(${h} ${sat}% 55%)`,'--accent-soft':`hsl(${h} ${sat}% 80%)`,'--accent-pale':`hsl(${h} ${sat}% 95%)`,'--accent-wash':`hsl(${h} ${sat}% 97%)`,'--accent-shadow':`hsl(${h} ${sat}% 30% / .24)`};
  for(const [k,v] of Object.entries(vars))root.style.setProperty(k,v);
  root.dataset.theme='custom';const hex=rgbHex(hsvToRgb(h,themeState.s));document.querySelector('meta[name="theme-color"]')?.setAttribute('content',hex);if($('themeColorValue'))$('themeColorValue').textContent=hex.toUpperCase();
  root.style.setProperty('--app-hue',h);root.style.setProperty('--app-saturation',sat+'%');
  if(themeWheel)position(themeWheel,themeState,'color');
  if(persist){localStorage.setItem('roggy-custom-color',JSON.stringify({h,s:themeState.s}));localStorage.setItem('roggy-theme','custom');}
}
if(themeWheel){attachWheel(themeWheel,()=>themeState,s=>theme(s,true));theme(themeState);}
window.addEventListener('roggy-auth',e=>{if(!e.detail?.signedIn){queue.clear();dialog.close();remembered.clear();}});
window.LightControls={roomMarkup,sync,openDevice:id=>open({kind:'device',id}),openRoom:room=>open({kind:'room',room})};
api.render();
