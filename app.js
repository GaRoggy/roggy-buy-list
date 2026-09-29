const SUPABASE_URL="https://dplvxsniyqkwlmdzqbyg.supabase.co";
const SUPABASE_KEY="sb_publishable_4WYS4v4U7PSgXesYNNJUfA_69lJaBX1";
const KEY="roggy-lists-v1";
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{flowType:"pkce",detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
const $=id=>document.getElementById(id);
const PROJECT_KEY="roggy-projects-v1";
let projects=JSON.parse(localStorage.getItem(PROJECT_KEY)||"[]");
function saveProjects(){localStorage.setItem(PROJECT_KEY,JSON.stringify(projects))}

const seed={buy:[
["Indoor doormat","Home","Need"],["Outdoor doormat","Home","Need"],["Extended small mirror for office","Office","Want"],["Soft light for office meetings","Office","Want"],["Indoor mood lighting — lamps, LEDs, etc.","Home / Decoration","Eventually"],["Outdoor Christmas lights","Decoration","Eventually"],["Blackout curtains","Home","Need"],["Curtain rods x3","Home","Need"],["Fruit bowl","Kitchen","Want"],["Glass food storage container set","Kitchen","Need"],["Hard reusable ice packs for keeping food cold","Kitchen","Need"],["Soft reusable ice packs for injuries","Health / First Aid","Need"],["Flexible silicone ice trays","Kitchen","Need"]
].map((x,i)=>({id:"b"+(i+1),item:x[0],category:x[1],priority:x[2],quantity:x[0].includes("x3")?"3":"",status:"Looking",notes:"",deleted:false,created:"2026-09-17"})),
groceries:[{id:"g1",item:"Cuties oranges",category:"Produce",priority:"Need",quantity:"1",status:"Looking",notes:"",deleted:false,created:"2026-09-17"}]};

const FALLBACK_BASELINE=[
{dimension:"Race",category:"White",count:16},{dimension:"Race",category:"Black",count:4},{dimension:"Race",category:"Asian",count:6},{dimension:"Race",category:"Unknown",count:0},
{dimension:"Gender",category:"Woman",count:17},{dimension:"Gender",category:"Man",count:9},{dimension:"Gender",category:"Unknown",count:0},
{dimension:"Age",category:"14-25",count:1},{dimension:"Age",category:"25-39",count:17},{dimension:"Age",category:"40-59",count:3},{dimension:"Age",category:"60+",count:5},
{dimension:"Obese",category:"Yes",count:11},{dimension:"Obese",category:"No",count:15},{dimension:"Obese",category:"Unknown",count:0}
];

const IOWA={
Race:{White:87.7,Black:4.9,Asian:2.7},
Gender:{Woman:50.2,Man:49.8},
Age:{"14-25":18.45,"25-39":22.84,"40-59":28.00,"60+":30.71},
Obese:{Yes:37.5,No:62.5}
};

let data={buy:[],groceries:[]},currentPage="reminders",currentView="active",currentFilter="all";
let baseline=FALLBACK_BASELINE,drivers=[],driverView="overview",charts={};
let reminders=[],reminderView="today",remindersLoaded=false,reminderSessionVersion=0,lastPrimaryPage="home",shelfReturnPage="home";
let monitorEmails=[],monitorEmailMessage="Sign in to view monitored email.";
let digestibles=[],digestView="books",digestStatusView="queue";
const SMART_HOME_API=(window.ROGGY_SMART_HOME_API||window.ROGGY_AI_CONFIG?.smartHomeUrl||"").replace(/\/$/,"");
let smartHomeState={devices:[],rooms:[],events:[],diagnostics:null},smartHomeLoaded=false,smartHomeUnavailable=false,smartHomeFailure=null,smartHomeLoading=null,smartHomeStreamPromise=null,smartHomeStreamAbort=null,smartHomeStreamRetry=null,smartHomeLastEventId="",smartHomeControlAllowed=false,smartHomeAccessToken="",smartHomePendingActions=new Map(),smartHomeActionSequence=0;
let layneChatMessages=[],layneChatBusy=false,layneChatError="";


function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function showErr(e,target="status"){const el=$(target);if(el)el.textContent="Sync error: "+(e?.message||e)}
function deviceOnline(device){return device?.availability==="online"}
function deviceFresh(device){return device?.freshness!=="stale"}
function deviceUsable(device){return deviceOnline(device)&&deviceFresh(device)}
function smartStateLabel(value){return String(value??"unknown").replaceAll("_"," ").toLowerCase().replace(/\b\w/g,m=>m.toUpperCase())}
function smartTime(value){if(!value)return "";const date=new Date(value);return Number.isNaN(date.getTime())?"":date.toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}
function smartClock(value){if(!value)return "";const date=new Date(value);return Number.isNaN(date.getTime())?"":date.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}
function smartRelative(value){if(!value)return "";const age=Math.max(0,Date.now()-new Date(value).getTime());if(!Number.isFinite(age))return "";const seconds=Math.round(age/1000);if(seconds<10)return "just now";if(seconds<60)return `${seconds} sec ago`;const minutes=Math.round(seconds/60);if(minutes<60)return `${minutes} min ago`;const hours=Math.round(minutes/60);if(hours<24)return `${hours} hr ago`;const days=Math.round(hours/24);return `${days} day${days===1?"":"s"} ago`}
function smartErrorMessage(error){if(error?.name==="AbortError")return "request timed out";return error?.payload?.error?.code||error?.code||error?.message||"Smart-home service unavailable."}
async function smartHomeFetch(path,options={}){
 if(!SMART_HOME_API)throw Object.assign(new Error("Smart-home bridge is not configured"),{code:"bridge_not_configured",status:0});
 const {timeoutMs=12000,...requestOptions}=options,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),timeoutMs);
 let response;try{response=await fetch(SMART_HOME_API+path,{cache:"no-store",...requestOptions,signal:controller.signal,headers:{Accept:"application/json",...(smartHomeAccessToken?{Authorization:`Bearer ${smartHomeAccessToken}`}:{ }),...(requestOptions.headers||{})}})}finally{clearTimeout(timeout)}
 let payload=null;try{payload=await response.json()}catch{}
 if(!response.ok)throw Object.assign(new Error(smartErrorMessage({payload})),{payload,status:response.status});
 return payload||{};
}
function smartFailureKind(error){if(!SMART_HOME_API||error?.code==="bridge_not_configured")return "bridge";if([401,403].includes(error?.status)||["UNAUTHORIZED","FORBIDDEN","authentication_required","authentication_failed"].includes(error?.payload?.error?.code))return "authentication";if(error?.status>=500)return "service";return "network"}
function diagnosticTone(status){return ["online","authenticated"].includes(status)?"online":status==="degraded"?"stale":"offline"}
function diagnosticLabel(status){return ["online","authenticated"].includes(status)?"Online":status==="degraded"?"Degraded":status==="unknown"?"Unknown":"Offline"}
function renderDeviceDiagnostics(){
 const root=$("deviceDiagnostics");if(!root)return;
 const diagnostics=smartHomeState.diagnostics||{},failure=smartHomeFailure;
 const rows=[
  ["Bridge",diagnostics.bridge?.status||(!SMART_HOME_API||failure==="bridge"?"offline":"unknown"),diagnostics.bridge?.transport==="private_tailscale"?"Private Tailscale HTTPS":"Secure bridge path"],
  ["Authentication",diagnostics.authentication?.status||(failure==="authentication"?"offline":"unknown"),failure==="authentication"?"Owner session rejected":"Owner session"],
  ["Layne",diagnostics.layne?.status||"unknown",diagnostics.layne?.reason==="not_configured"?"Health check not configured":"Local agent health"],
  ["Smart-home service",diagnostics.smart_home?.status||(failure==="service"?"offline":"unknown"),diagnostics.smart_home?.reason==="network_error"?"Bridge cannot reach PC service":"PC service / registry"]
 ];
 root.innerHTML=`<div class="device-diagnostics-grid">${rows.map(([name,status,detail])=>`<article class="device-diagnostic-card"><div><span>${esc(name)}</span><small>${esc(detail)}</small></div><b class="device-status-badge ${diagnosticTone(status)}">${diagnosticLabel(status)}</b></article>`).join("")}</div>${failure?`<p class="device-diagnostics-error">API: ${esc(failure==="authentication"?"Authentication failed":failure==="bridge"?"Bridge unavailable":failure==="service"?"Smart-home service unavailable":"Network/API request failed")} · ${esc(smartErrorMessage({code:failure}))}</p>`:""}`;
}
function deviceTypeLabel(device){return smartStateLabel(device?.type||"device")}
function deviceBrightness(device){const value=device?.attributes?.brightness;return Number.isFinite(Number(value))?Math.max(0,Math.min(100,Math.round(Number(value)))):null}
function devicePowerState(device){
 const raw=device?.state??device?.attributes?.power;
 if(raw===true||["on","true","1","active"].includes(String(raw).toLowerCase()))return "on";
 if(raw===false||["off","false","0","inactive"].includes(String(raw).toLowerCase()))return "off";
 return String(raw??"unknown").toLowerCase();
}
function deviceLastActivity(device){const attrs=device?.attributes||{};return device?.last_state_changed_at||attrs.last_state_change||attrs.last_event_received||attrs.last_detected_at||attrs.last_detected||attrs.last_audio_at||device?.last_seen}
function deviceFreshnessLine(device){if(!deviceOnline(device))return deviceLastActivity(device)?`Last seen ${smartRelative(deviceLastActivity(device))}`:"Offline";if(!deviceFresh(device))return `State stale${deviceLastActivity(device)?` · ${smartRelative(deviceLastActivity(device))}`:""}`;const relative=smartRelative(deviceLastActivity(device));return relative?`Updated ${relative}`:"Updated just now"}
function deviceStatusTone(device){if(!deviceOnline(device))return "offline";if(!deviceFresh(device))return "stale";return "online"}
function deviceStatusLine(device){
 if(!deviceOnline(device))return "Offline";
 if(!deviceFresh(device))return "Stale";
 const capabilities=device.capabilities||[],state=devicePowerState(device);
 if(capabilities.includes("power")){
   const brightness=deviceBrightness(device);
   return state==="on"?(brightness==null?"On":`On · ${brightness}%`):state==="off"?"Off":smartStateLabel(state);
 }
 if(capabilities.includes("presence"))return smartStateLabel(device.state);
 if(capabilities.some(x=>["audio_input","microphone_status","status","health"].includes(x)))return `Online · ${smartStateLabel(device.state)}`;
 return state==="unknown"?"Online":smartStateLabel(device.state);
}
function capabilityLabel(capability){return smartStateLabel(capability)}
function presenceLastDetected(device){const attrs=device?.attributes||{};return attrs.last_detected_at||attrs.last_detected||attrs.last_state_change||attrs.last_event_received||device?.last_seen}
function unknownCapabilityMarkup(device){
 const known=new Set(["power","brightness","presence","audio_input","microphone_status","status","health"]);
 return (device.capabilities||[]).filter(capability=>!known.has(capability)).map(capability=>`<span class="device-capability">${esc(capabilityLabel(capability))}</span>`).join("");
}
function deviceControlsMarkup(device){
 const capabilities=device.capabilities||[],online=deviceUsable(device),id=esc(device.device_id),locked=!smartHomeControlAllowed;
 let html="";
 if(capabilities.includes("power")){
   const state=devicePowerState(device);
   html+=`<div class="device-control-group"><span class="device-control-label">Power</span><div class="device-toggle"><button type="button" class="device-action ${state==="on"?"selected":""}" data-device-id="${id}" data-device-action="power" data-device-value="on" ${!online||locked?"disabled":""}>On</button><button type="button" class="device-action ${state==="off"?"selected":""}" data-device-id="${id}" data-device-action="power" data-device-value="off" ${!online||locked?"disabled":""}>Off</button></div></div>`;
 }
 if(capabilities.includes("brightness")){
   const brightness=deviceBrightness(device),value=brightness==null?0:brightness;
   html+=`<div class="device-control-group"><div class="device-control-heading"><span class="device-control-label">Brightness</span><b data-device-brightness-output="${id}">${brightness==null?"—":brightness+"%"}</b></div><input class="device-range" type="range" min="0" max="100" step="1" value="${value}" data-device-id="${id}" data-device-action="brightness" aria-label="${esc(device.friendly_name||"Device")} brightness" ${!online||locked?"disabled":""}></div>`;
 }
 if(capabilities.includes("presence")){
   const detected=presenceLastDetected(device);
   const attrs=device.attributes||{},metadata=attrs.metadata||{};
   html+=`<div class="device-info-row"><span>Presence</span><b>${esc(deviceStatusLine(device)==="Stale"?"Stale":online?smartStateLabel(device.state):"Offline")}</b></div>${detected?`<div class="device-info-row"><span>Last detected</span><b>${esc(smartTime(detected)||"Available")}</b></div>`:""}${metadata.illumination!=null?`<div class="device-info-row"><span>Illumination</span><b>${esc(metadata.illumination)}</b></div>`:""}${metadata.linkquality!=null?`<div class="device-info-row"><span>Link quality</span><b>${esc(metadata.linkquality)}</b></div>`:""}`;
 }
 if(capabilities.some(x=>["audio_input","microphone_status","status","health"].includes(x)))html+=`<div class="device-info-row"><span>Status</span><b>${esc(online?smartStateLabel(device.state):"Offline")}</b></div>`;
 const future=unknownCapabilityMarkup(device);if(future)html+=`<div class="device-capabilities"><span class="device-control-label">Capabilities</span><div>${future}</div></div>`;
 if(locked&&capabilities.some(x=>["power","brightness"].includes(x)))html+=`<p class="device-control-note">Sign in to control devices.</p>`;
 return html||`<div class="device-info-row"><span>State</span><b>${esc(deviceOnline(device)?smartStateLabel(device.state):"Offline")}</b></div>`;
}
function deviceCardMarkup(device){
 const tone=deviceStatusTone(device),id=esc(device.device_id);
 return `<article class="device-card ${tone!=="online"?"device-offline":""}" id="device-card-${id}" data-device-card="${id}"><div class="device-card-head"><div><h3>${esc(device.friendly_name||device.device_id)}</h3><p>${esc(deviceTypeLabel(device))} · ${esc(smartStateLabel(device.room||"unassigned"))}</p></div><span class="device-status-badge ${tone}">${tone==="online"?"Online":tone==="stale"?"Stale":"Offline"}</span></div><div class="device-current-state"><span>Current state</span><b>${esc(deviceStatusLine(device))}</b></div><div class="device-controls">${deviceControlsMarkup(device)}</div><div class="device-updated">${esc(deviceFreshnessLine(device))}</div></article>`;
}
function roomDevices(room){return room?.devices?.length?room.devices:smartHomeState.devices.filter(device=>(device.room||"unassigned")===(room.room_id||"unassigned"))}
function smartHomeRooms(){
 const byId=new Map((smartHomeState.rooms||[]).map(room=>[room.room_id,{...room,devices:[]}]))
 smartHomeState.devices.forEach(device=>{const roomId=device.room||"unassigned";if(!byId.has(roomId))byId.set(roomId,{room_id:roomId,friendly_name:smartStateLabel(roomId),devices:[]});byId.get(roomId).devices.push(device)});
 return [...byId.values()].map(room=>({...room,devices:room.devices.length?room.devices:roomDevices(room)})).sort((a,b)=>roomAttentionScore(b)-roomAttentionScore(a));
}
function roomPresenceLabel(room){const devices=roomDevices(room),sensors=devices.filter(device=>device.capabilities?.includes("presence")),valid=sensors.filter(device=>deviceUsable(device)&&String(device.state||"").toLowerCase()!=="unknown");if(!sensors.length)return "Presence unavailable";if(!valid.length)return sensors.some(device=>deviceOnline(device))?"Presence stale":"Offline";return valid.some(device=>["occupied","present","detected","motion"].includes(String(device.state||"").toLowerCase()))?"Occupied":"Clear"}
function roomLightLabel(room){const lights=roomDevices(room).filter(device=>device.capabilities?.includes("power")),active=lights.filter(device=>deviceUsable(device)&&devicePowerState(device)==="on"),brightness=active.map(deviceBrightness).filter(value=>value!=null);if(!lights.length)return "Lights: —";if(!active.length)return "Lights: Off";if(active.length===1&&brightness.length===1)return `Lights: On · ${brightness[0]}%`;return `Lights: ${active.length} on`}
function roomMicrophoneLabel(room){const microphones=roomDevices(room).filter(device=>device.capabilities?.some(capability=>["audio_input","microphone_status"].includes(capability)));if(!microphones.length)return "";const active=microphones.filter(device=>deviceUsable(device));return active.length?`Microphone: ${smartStateLabel(active[0].state)}`:`Microphone: ${microphones.some(device=>deviceOnline(device))?"Stale":"Offline"}`}
function roomAttentionScore(room){const devices=roomDevices(room),offline=devices.filter(device=>!deviceOnline(device)).length,stale=devices.filter(device=>deviceOnline(device)&&!deviceFresh(device)).length,occupied=roomPresenceLabel(room)==="Occupied",active=devices.some(device=>deviceUsable(device)&&!(["off","clear","unknown"].includes(String(device.state||"").toLowerCase())));return offline*100+stale*50+(occupied?10:0)+(active?5:0)}
function roomHealthLine(room){const devices=roomDevices(room),offline=devices.filter(device=>!deviceOnline(device)).length,stale=devices.filter(device=>deviceOnline(device)&&!deviceFresh(device)).length;if(offline)return `${offline} device${offline===1?"":"s"} offline`;if(stale)return `${stale} state${stale===1?"":"s"} stale`;return "All systems normal"}
function deviceActivityText(event){const device=smartHomeState.devices.find(item=>item.device_id===event.device_id),name=device?.friendly_name||event.device_id||"Smart home";if(event.type==="command.request")return "Layne command received";if(event.type==="device.online")return `${name} came online`;if(event.type==="device.offline")return `${name} went offline`;if(event.type==="device.state_changed")return `${name} · ${smartStateLabel(event.new)}`;return "Smart-home update"}
function recentSmartHomeEvents(){return (smartHomeState.events||[]).filter(event=>event.type?.startsWith("device.")||event.type==="command.request").slice().sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,5)}
function focusDevice(deviceId){setPage("devices");setTimeout(()=>{const card=document.querySelector(`[data-device-card="${CSS.escape(deviceId)}"]`);if(card){card.scrollIntoView({behavior:"smooth",block:"center"});card.classList.add("device-highlight");setTimeout(()=>card.classList.remove("device-highlight"),1600)}},50)}
function bindHomeDeviceLinks(){document.querySelectorAll("[data-device-jump]").forEach(button=>button.onclick=()=>focusDevice(button.dataset.deviceJump));document.querySelectorAll("[data-room-jump]").forEach(button=>button.onclick=()=>{setPage("devices");setTimeout(()=>document.getElementById(`smart-room-${CSS.escape(button.dataset.roomJump)}`)?.scrollIntoView({behavior:"smooth",block:"start"}),50)})}
function snapshotDevice(device){return device?{...device,attributes:{...(device.attributes||{})}}:null}
function beginDeviceAction(deviceId,body){
 const device=smartHomeState.devices.find(item=>item.device_id===deviceId),previous=snapshotDevice(device);if(!previous)return {previous:null,version:0};
 const version=++smartHomeActionSequence;
 smartHomePendingActions.delete(deviceId);
 applyDeviceActionState(deviceId,body);
 smartHomePendingActions.set(deviceId,{version,body,optimistic:snapshotDevice(smartHomeState.devices.find(device=>device.device_id===deviceId)),awaitingConfirmation:false,expiresAt:Date.now()+10000});
 renderHomeDeviceStatus();renderDevicesPage();
 return {previous,version};
}
function pendingDeviceState(device){
 const pending=smartHomePendingActions.get(device.device_id);if(!pending)return device;
 if(pending.expiresAt<Date.now()){smartHomePendingActions.delete(device.device_id);return device}
 return {...device,state:pending.optimistic?.state,attributes:{...(device.attributes||{}),...(pending.optimistic?.attributes||{})},freshness:"fresh",last_state_changed_at:pending.optimistic?.last_state_changed_at||device.last_state_changed_at};
}
function actionStillCurrent(deviceId,version){return version>0&&smartHomePendingActions.get(deviceId)?.version===version}
async function refreshAfterDeviceAction(deviceId,version){
 const refreshed=await loadSmartHome({silent:true});
 if(actionStillCurrent(deviceId,version)){
  setTimeout(async()=>{if(!actionStillCurrent(deviceId,version))return;smartHomePendingActions.delete(deviceId);await loadSmartHome({silent:true}).catch(()=>{})},1500);
 }
 return refreshed;
}
function applyDeviceActionState(deviceId,body){
 const device=smartHomeState.devices.find(item=>item.device_id===deviceId);if(!device)return null;
 const previous=snapshotDevice(device),action=String(body?.action||"").toLowerCase();
 if(action==="power"&&device.capabilities?.includes("power"))device.state=String(body.value).toLowerCase()==="off"?"off":"on";
 if(action==="brightness"&&device.capabilities?.includes("brightness")){
  const value=Math.max(0,Math.min(100,Math.round(Number(body.value))));
  if(Number.isFinite(value))device.attributes={...(device.attributes||{}),brightness:value};
 }
 if((action==="power"&&device.capabilities?.includes("power"))||(action==="brightness"&&device.capabilities?.includes("brightness"))){
  device.freshness="fresh";
  device.last_state_changed_at=new Date().toISOString();
  renderHomeDeviceStatus();renderDevicesPage();
 }
 return previous;
}
function restoreDeviceSnapshot(deviceId,previous){
 const device=smartHomeState.devices.find(item=>item.device_id===deviceId);if(!device||!previous)return;
 Object.assign(device,previous);renderHomeDeviceStatus();renderDevicesPage();
}
async function sendRoomPower(roomId,value){
 const room=smartHomeRooms().find(item=>item.room_id===roomId),lights=roomDevices(room).filter(device=>device.capabilities?.includes("power")&&deviceUsable(device));if(!lights.length)return;
 const status=$("deviceStatus"),actions=lights.map(device=>({device,action:beginDeviceAction(device.device_id,{action:"power",value})}));if(status)status.textContent="Updating room lights…";
 try{await Promise.all(actions.map(({device})=>smartHomeFetch(`/devices/${encodeURIComponent(device.device_id)}/actions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"power",value})})));let refreshed=true;for(const {device,action} of actions)if(actionStillCurrent(device.device_id,action.version))refreshed=await refreshAfterDeviceAction(device.device_id,action.version)&&refreshed;if(status)status.textContent=refreshed?"Room lights updated.":"Room lights command sent; showing requested state until devices confirm."}
 catch(error){actions.forEach(({device,action})=>{if(actionStillCurrent(device.device_id,action.version)){smartHomePendingActions.delete(device.device_id);restoreDeviceSnapshot(device.device_id,action.previous)}});if(status)status.textContent="Room light update failed: "+smartErrorMessage(error)}
}
function renderHomeDeviceStatus(){
 const root=$("homeDeviceStatus");if(!root)return;
 smartHomeState.devices=smartHomeState.devices.map(pendingDeviceState);
 if(smartHomeUnavailable){root.innerHTML=`<div class="quiet-state"><b>Smart Home</b><br>${esc(smartFailureKind(smartHomeFailure)==="authentication"?"Authentication failed.":"Bridge or smart-home service unavailable.")}</div>`;return}
 if(!smartHomeLoaded){root.innerHTML='<div class="quiet-state">Loading device status…</div>';return}
 if(!smartHomeState.devices.length){root.innerHTML='<div class="quiet-state">No devices configured.</div>';return}
 root.innerHTML=smartHomeState.devices.map(device=>`<button type="button" class="home-device-row" data-home-jump="devices"><span class="home-device-dot ${deviceOnline(device)?"online":"offline"}></span><b>${esc(device.friendly_name||device.device_id)}</b><span>${esc(deviceStatusLine(device))}</span></button>`).join("");
 const rooms=smartHomeRooms(),events=recentSmartHomeEvents();
 const roomMarkup=rooms.map(room=>{const lights=roomDevices(room).filter(device=>device.capabilities?.includes("power")&&deviceUsable(device));return `<article class="home-room-card"><button type="button" class="home-room-open" data-room-jump="${esc(room.room_id)}"><div><span class="eyebrow">ROOM</span><b>${esc(room.friendly_name||room.room_id)}</b></div><strong>${esc(roomPresenceLabel(room))}</strong><span>${esc(roomLightLabel(room))}</span>${roomMicrophoneLabel(room)?`<span>${esc(roomMicrophoneLabel(room))}</span>`:""}<small>${esc(room.online_devices??roomDevices(room).filter(device=>deviceOnline(device)).length)}/${esc(room.device_count??roomDevices(room).length)} devices online · ${esc(roomHealthLine(room))}</small></button>${lights.length?`<div class="home-room-quick"><span>Quick lights</span><button type="button" data-room-action="on" data-room-id="${esc(room.room_id)}">On</button><button type="button" data-room-action="off" data-room-id="${esc(room.room_id)}">Off</button></div>`:""}</article>`}).join("");
 const rows=smartHomeState.devices.slice().sort((a,b)=>(!deviceOnline(b)?1:!deviceOnline(a)?-1:!deviceFresh(b)?1:!deviceFresh(a)?-1:0)).map(device=>`<button type="button" class="home-device-row" data-device-jump="${esc(device.device_id)}"><span class="home-device-dot ${deviceStatusTone(device)}"></span><b>${esc(device.friendly_name||device.device_id)}</b><span>${esc(deviceStatusLine(device))}<small>${esc(deviceFreshnessLine(device))}</small></span></button>`).join("");
 const activity=events.length?`<div class="home-activity"><div class="home-subhead"><span>RECENT ACTIVITY</span><small>Latest ${events.length}</small></div>${events.map(event=>`<div class="home-activity-row"><time>${esc(smartClock(event.timestamp))}</time><span>${esc(deviceActivityText(event))}</span></div>`).join("")}</div>`:"";
 root.innerHTML=`<div class="home-room-summary-grid">${roomMarkup}</div><div class="home-device-list">${rows}</div>${activity}`;
 bindHomeDeviceLinks();document.querySelectorAll("[data-room-action]").forEach(button=>button.onclick=()=>sendRoomPower(button.dataset.roomId,button.dataset.roomAction));
}
function renderDevicesPage(){
 const summary=$("deviceRoomSummary"),rooms=$("deviceRooms");if(!summary||!rooms)return;
 smartHomeState.devices=smartHomeState.devices.map(pendingDeviceState);
 renderDeviceDiagnostics();
 const hasSnapshot=smartHomeLoaded||smartHomeState.devices.length>0||smartHomeState.rooms.length>0;
 if(smartHomeUnavailable&&!hasSnapshot){summary.innerHTML="";rooms.innerHTML=`<div class="system-card"><b>Smart-home data unavailable</b><p>${esc(smartErrorMessage({code:smartHomeFailure||"network_error"}))}. The bridge will keep retrying while this page is open.</p></div>`;return}
 if(!hasSnapshot){summary.innerHTML="";rooms.innerHTML='<div class="system-card"><b>Loading device status…</b></div>';return}
 if(!smartHomeState.devices.length){summary.innerHTML="";rooms.innerHTML='<div class="system-card"><b>No devices configured</b><p>Add a device to Layne’s registry and it will appear here automatically.</p></div>';return}
 const grouped=smartHomeRooms();
 summary.innerHTML=grouped.map(room=>`<button type="button" class="device-room-summary-card" data-room-jump="${esc(room.room_id)}"><span>${esc(room.friendly_name||room.room_id)}</span><b>${room.online_devices??roomDevices(room).filter(device=>deviceOnline(device)).length}/${room.device_count??roomDevices(room).length}</b><small>online · ${esc(roomHealthLine(room))}</small></button>`).join("");
 rooms.innerHTML=grouped.map(room=>{const roomState=roomPresenceLabel(room);return `<section class="device-room" id="smart-room-${esc(room.room_id)}" data-room-section="${esc(room.room_id)}"><div class="device-room-head"><div><span class="eyebrow">ROOM</span><h3>${esc(room.friendly_name||room.room_id)}</h3></div><span class="room-presence-badge ${roomState==="Offline"||roomState.includes("stale")?"offline":""}">${esc(roomState)}</span></div><div class="device-grid">${roomDevices(room).slice().sort((a,b)=>(deviceStatusTone(a)==="online"?1:-1)-(deviceStatusTone(b)==="online"?1:-1)).map(device=>deviceCardMarkup(device)).join("")}</div></section>`}).join("");
 bindDeviceControls();
 bindHomeDeviceLinks();
}
function bindDeviceControls(){
 document.querySelectorAll("[data-device-action=power]").forEach(button=>button.onclick=()=>sendDeviceAction(button.dataset.deviceId,{action:"power",value:button.dataset.deviceValue}));
 document.querySelectorAll("[data-device-action=brightness]").forEach(input=>{input.oninput=()=>{const output=document.querySelector(`[data-device-brightness-output="${CSS.escape(input.dataset.deviceId)}"]`);if(output)output.textContent=input.value+"%"};input.onchange=()=>sendDeviceAction(input.dataset.deviceId,{action:"brightness",value:Number(input.value)})});
}
async function sendDeviceAction(deviceId,body){
 if(!smartHomeControlAllowed){const status=$("deviceStatus");if(status)status.textContent="Sign in to control devices.";return}
 const status=$("deviceStatus"),action=beginDeviceAction(deviceId,body);if(status)status.textContent="Updating device…";
 try{await smartHomeFetch(`/devices/${encodeURIComponent(deviceId)}/actions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!actionStillCurrent(deviceId,action.version))return;const refreshed=await refreshAfterDeviceAction(deviceId,action.version);if(status)status.textContent=refreshed?"Device state updated.":"Device command sent; showing requested state until the device confirms."}
 catch(error){if(actionStillCurrent(deviceId,action.version)){smartHomePendingActions.delete(deviceId);restoreDeviceSnapshot(deviceId,action.previous);if(status)status.textContent="Device update failed: "+smartErrorMessage(error)}}
}
function connectSmartHomeStream(){
 if(smartHomeStreamPromise||!smartHomeAccessToken||!SMART_HOME_API)return;
 const controller=new AbortController();smartHomeStreamAbort=controller;
 smartHomeStreamPromise=(async()=>{try{
   const response=await fetch(SMART_HOME_API+"/events/stream",{cache:"no-store",headers:{Accept:"text/event-stream",Authorization:`Bearer ${smartHomeAccessToken}`,...(smartHomeLastEventId?{"Last-Event-ID":smartHomeLastEventId}: {})},signal:controller.signal});
   if(!response.ok||!response.body)throw new Error(`event stream ${response.status}`);
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";
   while(!controller.signal.aborted){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop()||"";for(const frame of frames){const id=frame.match(/^id:\s*(.+)$/m);if(id)smartHomeLastEventId=id[1].trim();const data=frame.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).join("\n");if(data)loadSmartHome({silent:true}).catch(()=>{})}}
 }catch(error){if(!controller.signal.aborted&&!smartHomeStreamRetry)smartHomeStreamRetry=setTimeout(()=>{smartHomeStreamRetry=null;connectSmartHomeStream()},15000)}finally{smartHomeStreamPromise=null;smartHomeStreamAbort=null}})();
}
async function loadSmartHome({silent=false}={}){
 if(smartHomeLoading)return smartHomeLoading;
 smartHomeLoading=(async()=>{try{smartHomeFailure=null;const diagnostics=await smartHomeFetch("/diagnostics");smartHomeState.diagnostics=diagnostics;renderDeviceDiagnostics();const [devices,rooms]=await Promise.all([smartHomeFetch("/devices"),smartHomeFetch("/rooms")]);let history={events:[]};try{history=await smartHomeFetch("/events/history?limit=40")}catch{}smartHomeState={devices:Array.isArray(devices.devices)?devices.devices:[],rooms:Array.isArray(rooms.rooms)?rooms.rooms:[],events:Array.isArray(history.events)?history.events:[],diagnostics};smartHomeLoaded=true;smartHomeUnavailable=false;if($("deviceStatus")&&(!$("deviceStatus").textContent||$("deviceStatus").textContent.startsWith("Smart-home unavailable:")))$("deviceStatus").textContent="";renderHomeDeviceStatus();renderDevicesPage();connectSmartHomeStream();return true}catch(error){smartHomeFailure=smartFailureKind(error);const hasSnapshot=smartHomeLoaded||smartHomeState.devices.length>0||smartHomeState.rooms.length>0;if(hasSnapshot){smartHomeLoaded=true;smartHomeUnavailable=false;if(!silent&&$("deviceStatus"))$("deviceStatus").textContent="Refresh unavailable; showing last known device state."}else{smartHomeLoaded=false;smartHomeUnavailable=true;if(!silent&&$("deviceStatus"))$("deviceStatus").textContent="Smart-home unavailable: "+smartErrorMessage(error)}renderHomeDeviceStatus();renderDevicesPage();connectSmartHomeStream();return false}finally{smartHomeLoading=null}})();
 return smartHomeLoading;
}
setInterval(()=>{if(!document.hidden&&(currentPage==="home"||currentPage==="devices")&&!smartHomeStreamPromise)loadSmartHome({silent:true}).catch(()=>{})},30000);
function layneResponseText(payload){if(typeof payload==="string")return payload;if(payload?.message)return String(payload.message);if(payload?.answer)return String(payload.answer);if(typeof payload?.result==="string")return payload.result;if(payload?.result?.message)return String(payload.result.message);return "Layne returned a response without text."}
function renderLayneChat(){const history=$("layneChatHistory"),error=$("layneChatError"),send=$("layneChatSend"),status=$("layneChatStatus");if(!history)return;history.innerHTML=layneChatMessages.map(message=>`<div class="layne-chat-message ${message.role===`user`?"user":"assistant"}"><b>${message.role===`user`?"You":"Layne"}</b><p>${esc(message.text)}</p></div>`).join("");history.scrollTop=history.scrollHeight;if(send)send.disabled=layneChatBusy||!smartHomeControlAllowed;if(status)status.textContent=layneChatBusy?"Layne is thinking…":"";if(error)error.textContent=layneChatError}
function openLayneChat(){const dialog=$("layneChatDialog");if(!dialog)return;if(!smartHomeControlAllowed){$("layneChatError").textContent="Sign in to talk to Layne.";return}renderLayneChat();dialog.showModal();setTimeout(()=>$("layneChatPrompt")?.focus(),40)}
async function sendLayneChat(){const prompt=$("layneChatPrompt");if(!prompt||layneChatBusy)return;const text=prompt.value.trim();if(!text)return;if(!smartHomeControlAllowed){layneChatError="Sign in to talk to Layne.";renderLayneChat();return}layneChatError="";layneChatMessages.push({role:"user",text});prompt.value="";layneChatBusy=true;renderLayneChat();try{const payload=await smartHomeFetch("/commands",{method:"POST",timeoutMs:185000,headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});layneChatMessages.push({role:"assistant",text:layneResponseText(payload)});await loadSmartHome({silent:true})}catch(exception){layneChatError="Layne could not respond: "+smartErrorMessage(exception)}finally{layneChatBusy=false;renderLayneChat()}}
$("layneChatFab")?.addEventListener("click",openLayneChat);
$("layneChatClose")?.addEventListener("click",()=>$("layneChatDialog").close());
$("layneChatForm")?.addEventListener("submit",event=>{event.preventDefault();sendLayneChat()});
$("layneChatPrompt")?.addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();sendLayneChat()}});
function loadLocal(){try{const x=JSON.parse(localStorage.getItem(KEY));if(x?.buy&&x?.groceries)return x}catch{}return structuredClone(seed)}

async function loadLists(){
  const {data:rows,error}=await sb.from("list_items").select("*").order("created_at",{ascending:true});
  if(error){data=loadLocal();showErr(error);renderLists();return}
  data={buy:[],groceries:[]};
  for(const r of rows)data[r.list_type].push({id:r.id,item:r.item,category:r.category||"",priority:r.priority||"Need",quantity:r.quantity||"",status:r.status,notes:r.notes||"",option1:r.option1||"",price1:r.price1,link1:r.link1||"",option2:r.option2||"",price2:r.price2,link2:r.link2||"",option3:r.option3||"",price3:r.price3,link3:r.link3||"",deleted:!!r.deleted_at,deletedAt:r.deleted_at||null,created:r.created_at});
  localStorage.setItem(KEY,JSON.stringify(data));renderLists();
}
async function saveItem(x){
  localStorage.setItem(KEY,JSON.stringify(data));
  const {error}=await sb.from("list_items").update({item:x.item,category:x.category||null,priority:x.priority||null,quantity:x.quantity||null,status:x.status,notes:x.notes||null,deleted_at:x.deleted?(x.deletedAt||new Date().toISOString()):null}).eq("id",x.id);
  if(error)throw error;
}
async function insertItem(x){
  const {data:rows,error}=await sb.from("list_items").insert({list_type:currentPage,item:x.item,category:x.category||null,priority:x.priority||null,quantity:x.quantity||null,status:x.status,notes:x.notes||null}).select();
  if(error)throw error;if(rows?.[0])x.id=rows[0].id;localStorage.setItem(KEY,JSON.stringify(data));
}

function renderLists(){
  if(!["buy","groceries"].includes(currentPage))return;
  const arr=data[currentPage]||[],deleted=arr.filter(x=>x.deleted);const deletedTab=document.querySelector('#listsPage .sub-tab[data-view="deleted"]');if(deletedTab)deletedTab.childNodes[0].nodeValue=currentPage==="buy"?"Bought ":"Recently Deleted ";
  $("deletedCount").textContent=deleted.length?`(${deleted.length})`:"";
  $("pageTitle").textContent=currentPage==="buy"?"Buy List":"Groceries";
  $("pageSubtitle").textContent=currentPage==="buy"?"Needs first. Luxuries later.":"Food and immediate grocery items.";
  document.querySelector(".toolbar").style.display=currentView==="deleted"?"none":"";
   document.body.classList.toggle("deleted-view",currentView==="deleted");
  $("summary").style.display=currentView==="deleted"?"none":"";
  $("addBtn").style.display=currentView==="deleted"?"none":"";
  $("priorityFilters").style.display=currentPage==="groceries"?"none":"";
  const active=arr.filter(x=>!x.deleted),bought=active.filter(x=>x.status==="Bought").length,ready=active.filter(x=>x.status==="Ready to Buy").length;
  $("summary").innerHTML=`<div><b>${active.length-bought}</b><span>active</span></div><div><b>${ready}</b><span>ready</span></div><div><b>${bought}</b><span>bought</span></div>`;
  const q=$("search").value.toLowerCase(),rank={Need:0,Want:1,Eventually:2};
  let shown=arr.filter(x=>currentView==="deleted"?x.deleted:!x.deleted);if(currentView==="deleted"&&currentPage==="buy")shown.sort((a,b)=>new Date(b.deletedAt||b.created||0)-new Date(a.deletedAt||a.created||0))
    .filter(x=>currentPage==="groceries"||currentFilter==="all"||x.priority===currentFilter)
    .filter(x=>!q||[x.item,x.category,x.notes].join(" ").toLowerCase().includes(q));
  shown.sort($("sort").value==="name"?(a,b)=>a.item.localeCompare(b.item):(a,b)=>(rank[a.priority]??9)-(rank[b.priority]??9));
  $("list").innerHTML="";
  if(!shown.length){$("list").innerHTML='<div class="card empty">Nothing here yet.</div>';return}
  shown.forEach(x=>{
    const c=document.createElement("article");c.className="card "+(x.status==="Bought"?"bought":"");
    if(currentView==="deleted"){
      c.innerHTML=`<div class="deleted-row"><div><div class="item-name">${esc(x.item)}</div><div class="meta"><span>${esc(x.category||"Other")}</span>${currentPage==="buy"&&x.deletedAt?`<span>Bought ${new Date(x.deletedAt).toLocaleDateString([],{month:"short",day:"numeric",year:"numeric"})}</span>`:""}</div></div><button class="restorebtn" aria-label="Restore item" title="Restore item"><span class="restore-icon" aria-hidden="true">↶</span></button></div>`;
      c.querySelector(".restorebtn").onclick=()=>{x.deleted=false;x.deletedAt=null;x.status="Looking";saveItem(x).catch(showErr);renderLists()};$("list").appendChild(c);return;
    }
    c.innerHTML=`<div class="card-summary"><button class="removebtn icon-action remove-left">✕</button><div class="summary-main"><div class="item-name">${esc(x.item)}${x.quantity&&x.quantity!=="1"?` <small>×${esc(x.quantity)}</small>`:""}</div><div class="meta"><span>${esc(x.category||"Other")}</span><span>${esc(x.status)}</span></div></div><div class="card-controls">${currentPage==="buy"?`<button class="prioritybtn icon-action" data-dir="up">↑</button><span class="badge ${esc(x.priority)}">${esc(x.priority)}</span><button class="prioritybtn icon-action" data-dir="down">↓</button>`:""}<span class="chevron">⌄</span></div></div><div class="card-details collapsed"><div class="quick"><button class="statusbtn ${x.status==="Looking"?"selected":""}" data-s="Looking">Looking</button><button class="statusbtn ${x.status==="Ready to Buy"?"selected":""}" data-s="Ready to Buy">Ready</button><button class="statusbtn ${x.status==="Bought"?"selected":""}" data-s="Bought">✓ Bought</button></div>${x.notes?`<div class="detail-notes">${esc(x.notes)}</div>`:""}${currentPage==="buy"?renderResearch(x):""}<div class="bottom-actions"><button class="editbtn">Edit details</button><button class="deletebtn danger-action" type="button">Delete</button></div></div>`;
    c.querySelector(".card-summary").onclick=e=>{if(e.target.closest("button"))return;c.querySelector(".card-details").classList.toggle("collapsed");c.classList.toggle("expanded")};
    c.querySelector(".removebtn").onclick=()=>{if(currentPage==="buy")x.status="Bought";x.deleted=true;x.deletedAt=new Date().toISOString();saveItem(x).catch(showErr);renderLists()};
    c.querySelectorAll(".statusbtn").forEach(b=>b.onclick=()=>{x.status=b.dataset.s;saveItem(x).catch(showErr);renderLists()});
    c.querySelectorAll(".prioritybtn").forEach(b=>b.onclick=()=>changePriority(x,b.dataset.dir));
    c.querySelector(".editbtn").onclick=()=>openEdit(x);c.querySelector(".deletebtn").onclick=async()=>{if(!confirm(`Delete "${x.item}" permanently? This will not move it to ${currentPage==="buy"?"Bought":"Recently Deleted"}.`))return;const {error}=await sb.from("list_items").delete().eq("id",x.id);if(error){showErr(error);return}data[currentPage]=data[currentPage].filter(i=>i.id!==x.id);localStorage.setItem(KEY,JSON.stringify(data));renderLists()};$("list").appendChild(c);
  });
}
function safeLink(url){try{const u=new URL(url);return ["http:","https:"].includes(u.protocol)?u.href:""}catch{return ""}}
function renderResearch(x){
  const opts=[1,2,3].map(i=>({name:x["option"+i],price:x["price"+i],link:safeLink(x["link"+i])})).filter(o=>o.name||o.link);
  if(!opts.length)return '<div class="research-empty">No researched options yet.</div>';
  let out='<div class="research-options"><div class="research-title">Researched options</div>';
  for(const o of opts){
    out+='<div class="research-option"><div><b>'+esc(o.name||"Product option")+'</b>'+(o.price!=null?'<span>$'+Number(o.price).toFixed(2)+'</span>':'')+'</div>'+(o.link?'<a href="'+esc(o.link)+'" target="_blank" rel="noopener noreferrer">View product ↗</a>':'<span class="link-pending">Link not saved yet</span>')+'</div>';
  }
  return out+'</div>';
}
function changePriority(x,dir){const levels=["Eventually","Want","Need"],i=levels.indexOf(x.priority),n=Math.max(0,Math.min(2,i+(dir==="up"?1:-1)));x.priority=levels[n];saveItem(x).catch(showErr);renderLists()}
function setItemDestination(dest){
 dest=dest==="groceries"?"groceries":"buy";$("itemDestination").value=dest;
 document.querySelectorAll(".destination-choice").forEach(b=>{const active=b.dataset.destination===dest;b.classList.toggle("active",active);b.setAttribute("aria-pressed",active?"true":"false")});
 $("dialogTitle").textContent=dest==="buy"?"Add purchase":"Add grocery";
}
function closeItemDialog(){$("itemDialog").close()}
function openEdit(x){$("dialogTitle").textContent="Edit item";$("itemId").value=x.id;$("item").value=x.item;$("category").value=x.category||"";$("priority").value=x.priority||"Need";$("quantity").value=x.quantity||"";$("itemStatus").value=x.status||"Looking";$("notes").value=x.notes||"";$("itemDestinationWrap").hidden=true;$("itemDestination").value=currentPage;$("itemDialog").showModal()}
function openAddItem(){$("itemId").value="";$("itemForm").reset();$("priority").value="Need";$("itemDestinationWrap").hidden=false;setItemDestination(currentPage==="buy"?"buy":"groceries");$("itemDialog").showModal();setTimeout(()=>$("item").focus(),50)}
document.querySelectorAll(".destination-choice").forEach(b=>b.onclick=()=>setItemDestination(b.dataset.destination));
$("itemDialogClose").onclick=closeItemDialog;$("itemDialogCancel").onclick=closeItemDialog;

$("itemForm").addEventListener("submit",e=>{
  e.preventDefault();const id=$("itemId").value,target=id?currentPage:$("itemDestination").value;let x=id?data[target].find(v=>v.id===id):null;
  if(!x){x={id:crypto.randomUUID(),deleted:false,created:new Date().toISOString().slice(0,10)};data[target].push(x)}
  Object.assign(x,{item:$("item").value.trim(),category:$("category").value.trim(),priority:$("priority").value,quantity:$("quantity").value.trim(),status:$("itemStatus").value,notes:$("notes").value.trim()});
  const previousPage=currentPage;currentPage=target;(id?saveItem(x):insertItem(x)).catch(showErr);$("itemDialog").close();currentPage=previousPage;renderLists();
});

async function loadDrivers(){
  const [{data:b,error:be},{data:d,error:de}]=await Promise.all([
    sb.from("bad_driver_baseline_counts").select("dimension,category,count").eq("source","historical baseline"),
    sb.from("bad_drivers").select("*").order("observed_at",{ascending:false})
  ]);
  if(!be&&b?.length)baseline=b;if(de){showErr(de,"driverStatus");drivers=[]}else drivers=d||[];
  renderDriverPage();
}
function dimensionCounts(dim){
  const map={};
  baseline.filter(x=>x.dimension===dim).forEach(x=>map[x.category]=(map[x.category]||0)+Number(x.count||0));
  const field={Race:"race",Gender:"gender",Age:"age_group",Obese:"obese"}[dim];
  drivers.forEach(x=>{const k=x[field]||"Unknown";map[k]=(map[k]||0)+1});
  return map;
}
function totalObservations(){return 26+drivers.length}
function chartData(dim){
  const preferred={Race:["White","Black","Asian","Other","Unknown"],Gender:["Woman","Man","Unknown"],Age:["14-25","25-39","40-59","60+","Unknown"],Obese:["Yes","No","Unknown"]}[dim];
  const counts=dimensionCounts(dim);return preferred.filter(k=>(counts[k]||0)>0).map(k=>({label:k,value:counts[k]||0}));
}
function makePie(id,dim){
  if(charts[id])charts[id].destroy();const rows=chartData(dim);
  charts[id]=new Chart($(id),{type:"pie",data:{labels:rows.map(x=>x.label),datasets:[{data:rows.map(x=>x.value)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom"},tooltip:{callbacks:{label:c=>{const total=c.dataset.data.reduce((a,b)=>a+b,0);return ` ${c.label}: ${c.raw} (${(c.raw/total*100).toFixed(1)}%)`}}}}}});
}
function renderRatioChart(){
  const dim=$("ratioDimension").value,counts=dimensionCounts(dim),pop=IOWA[dim],labels=Object.keys(pop),total=totalObservations();
  const ratios=labels.map(k=>((counts[k]||0)/total*100)/pop[k]);
  if(charts.ratioChart)charts.ratioChart.destroy();
  charts.ratioChart=new Chart($("ratioChart"),{type:"bar",data:{labels,datasets:[{label:"Representation ratio",data:ratios},{type:"line",label:"Iowa proportional baseline",data:labels.map(()=>1),borderDash:[6,5],pointRadius:0,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true,title:{display:true,text:"Representation ratio (× Iowa share)"}}},plugins:{legend:{position:"bottom"},tooltip:{callbacks:{label:c=>c.dataset.type==="line"?" Iowa baseline: 1.00×":` ${c.dataset.label}: ${Number(c.raw).toFixed(2)}×`}}}}});
}
function wilson(k,n,z=1.96){if(!n)return[0,0];const p=k/n,d=1+z*z/n,mid=(p+z*z/(2*n))/d,half=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return[Math.max(0,mid-half),Math.min(1,mid+half)]}
function renderAnalysis(){
  const total=totalObservations(),dim=$("ratioDimension").value,counts=dimensionCounts(dim),pop=IOWA[dim];
  const rows=Object.keys(pop).map(k=>{const n=counts[k]||0,p=n/total*100,r=p/pop[k],[lo,hi]=wilson(n,total);return `<tr><td>${esc(k)}</td><td>${n}</td><td>${p.toFixed(1)}%</td><td>${pop[k].toFixed(1)}%</td><td><b>${r.toFixed(2)}×</b></td><td>${(lo*100).toFixed(1)}–${(hi*100).toFixed(1)}%</td></tr>`}).join("");
  $("analysisTable").innerHTML=`<div class="analysis-label">Showing: <b>${esc(dim==="Obese"?"Obesity":dim)}</b></div><div class="table-scroll"><table><thead><tr><th>Group</th><th>n</th><th>Your share</th><th>Iowa share</th><th>Ratio</th><th>95% CI for your share</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderDriverPage(){
  $("driverTotal").textContent=totalObservations();$("individualTotal").textContent=drivers.length;$("baselineTotal").textContent=26;
  if(driverView==="overview"){
    requestAnimationFrame(()=>{makePie("raceChart","Race");makePie("genderChart","Gender");makePie("ageChart","Age");makePie("obeseChart","Obese");renderRatioChart();renderAnalysis()});
  } else renderDriverList();
}
function renderDriverList(){
  const q=$("driverSearch").value.toLowerCase();let rows=drivers.filter(x=>!q||(x.description||"").toLowerCase().includes(q));
  const s=$("driverSort").value,ageRank={"14-25":0,"25-39":1,"40-59":2,"60+":3,Unknown:4};
  if(s==="newest")rows.sort((a,b)=>new Date(b.observed_at)-new Date(a.observed_at));
  if(s==="race")rows.sort((a,b)=>(a.race||"").localeCompare(b.race||""));
  if(s==="gender")rows.sort((a,b)=>(a.gender||"").localeCompare(b.gender||""));
  if(s==="age")rows.sort((a,b)=>(ageRank[a.age_group]??9)-(ageRank[b.age_group]??9));
  if(s==="obese")rows.sort((a,b)=>(a.obese||"").localeCompare(b.obese||""));
  $("driverList").innerHTML=rows.length?"":'<div class="card empty">No individual observations yet.</div>';
  rows.forEach(x=>{const el=document.createElement("button");el.className="driver-row";el.innerHTML=`<div class="driver-row-top"><b>${esc(x.race||"Unknown")} • ${esc(x.gender||"Unknown")}</b><span>${new Date(x.observed_at).toLocaleDateString()}</span></div><div class="driver-chips"><span>${esc(x.age_group||"Unknown")}</span><span>Obese: ${esc(x.obese||"Unknown")}</span></div><p>${esc((x.description||"").slice(0,120))}${(x.description||"").length>120?"…":""}</p>`;el.onclick=()=>openDriverDetail(x);$("driverList").appendChild(el)});
}
function openDriverDetail(x){
  $("driverDetail").innerHTML=`<div class="detail-grid"><div><span>Race</span><b>${esc(x.race||"Unknown")}</b></div><div><span>Gender</span><b>${esc(x.gender||"Unknown")}</b></div><div><span>Age</span><b>${esc(x.age_group||"Unknown")}</b></div><div><span>Obese?</span><b>${esc(x.obese||"Unknown")}</b></div></div><div class="detail-description"><span>Description</span><p>${esc(x.description||"No description")}</p></div><div class="detail-date">${new Date(x.observed_at).toLocaleString()}</div>`;
  $("driverDetailDialog").showModal();
}
async function addDriver(){
  const row={race:$("driverRace").value,gender:$("driverGender").value,age_group:$("driverAge").value,obese:$("driverObese").value,description:$("driverDescription").value.trim()};
  const {data:newRows,error}=await sb.from("bad_drivers").insert(row).select();if(error)throw error;
  if(newRows?.[0])drivers.unshift(newRows[0]);renderDriverPage();
}
$("driverForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();addDriver().catch(e=>showErr(e,"driverStatus"));$("driverDialog").close();$("driverForm").reset()});
$("closeDriverDetail").onclick=()=>$("driverDetailDialog").close();

async function loadReminders(){
  const version=reminderSessionVersion;
  const {data:{session}}=await sb.auth.getSession();
  if(version!==reminderSessionVersion)return;
  if(!isOwnerSession(session)){reminders=[];remindersLoaded=true;$("reminderStatus").textContent="Sign in to view private reminders.";renderReminders();return}
  const {data:r,error}=await sb.from("reminders").select("*").eq("user_id",session.user.id).eq("completed",false).is("cancelled_at",null).order("start_at",{ascending:true});
  if(version!==reminderSessionVersion)return;
  remindersLoaded=true;if(!error)$("reminderStatus").textContent="";
  if(error){showErr(error,"reminderStatus");reminders=[]}else reminders=r||[];
  renderReminders();
}
function localDay(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate())}
function renderReminders(){
  const now=new Date(),today=localDay(now),tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
  const afterTomorrow=new Date(tomorrow);afterTomorrow.setDate(tomorrow.getDate()+1);
  const weekEnd=new Date(today);weekEnd.setDate(today.getDate()+(7-today.getDay()));
  let start=today,end=tomorrow;
  if(reminderView==="tomorrow"){start=tomorrow;end=afterTomorrow}
  if(reminderView==="week"){start=today;end=weekEnd}
  const rows=reminders.filter(x=>{const d=reminderStart(x),finish=reminderEnd(x);return d<end&&(finish>start||d>=start)});
  $("reminderList").innerHTML=rows.length?"":'<div class="card empty">Nothing scheduled here.</div>';
  rows.forEach(x=>{const d=reminderStart(x),el=document.createElement("article");el.className="reminder-card";
    const when=x.all_day?"All day":d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
    const day=reminderView==="week"?d.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"}):"";
    el.innerHTML=`<div class="reminder-date">${esc(day)}</div><div class="reminder-body"><b>${esc(x.title)}</b><span>${esc(when)}</span></div>${x.source==="google_calendar"?'<span class="calendar-badge">Calendar</span>':""}`;
    $("reminderList").appendChild(el);
  });
}
document.querySelectorAll(".reminder-tab").forEach(b=>b.onclick=()=>{reminderView=b.dataset.reminderView;document.querySelectorAll(".reminder-tab").forEach(z=>z.classList.toggle("active",z===b));renderReminders()});


const BUDGET_PIN_KEY="roggy-budget-pin-v1",BUDGET_CRED_KEY="roggy-budget-credential-v1";let budgetUnlocked=false,budgetTimer=null,budgetEntries=[],budgetMode="monthly";
function bytesToB64(b){return btoa(String.fromCharCode(...new Uint8Array(b)))} function b64ToBytes(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function hashPin(pin,salt){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);return bytesToB64(await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:210000,hash:"SHA-256"},k,256))}
function budgetConfigured(){return !!localStorage.getItem(BUDGET_PIN_KEY)} function touchBudget(){clearTimeout(budgetTimer);if(budgetUnlocked)budgetTimer=setTimeout(lockBudget,5*60*1000)}
async function unlockBudget(){budgetUnlocked=true;$("budgetLock").hidden=true;$("budgetContent").hidden=false;touchBudget();await loadBudgetData()}
function lockBudget(){budgetUnlocked=false;clearTimeout(budgetTimer);$("budgetContent").hidden=true;$("budgetLock").hidden=false;budgetEntries=[];$("budgetFlow").innerHTML="";$("budgetTableBody").innerHTML=""}
async function setupBudgetPin(pin){const salt=crypto.getRandomValues(new Uint8Array(16)),hash=await hashPin(pin,salt);localStorage.setItem(BUDGET_PIN_KEY,JSON.stringify({salt:bytesToB64(salt),hash}))}
async function verifyBudgetPin(pin){const r=JSON.parse(localStorage.getItem(BUDGET_PIN_KEY)||"null");return !!r&&(await hashPin(pin,b64ToBytes(r.salt)))===r.hash}
async function setupPasskey(){if(!window.PublicKeyCredential)throw new Error("Passkeys are not supported on this device.");const cred=await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{name:"Roggy Lists"},user:{id:crypto.getRandomValues(new Uint8Array(32)),name:"budget-owner",displayName:"Budget Owner"},pubKeyCredParams:[{alg:-7,type:"public-key"},{alg:-257,type:"public-key"}],authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required",residentKey:"preferred"},timeout:60000,attestation:"none"}});localStorage.setItem(BUDGET_CRED_KEY,bytesToB64(cred.rawId))}
async function faceUnlock(){const id=localStorage.getItem(BUDGET_CRED_KEY);if(!id){await setupPasskey();$("budgetLockStatus").textContent="Face ID / passkey enabled.";await unlockBudget();return}await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),allowCredentials:[{type:"public-key",id:b64ToBytes(id)}],userVerification:"required",timeout:60000}});await unlockBudget()}
function money(n){return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(n||0))}
function normalizeBudgetAmount(x){let n=Number(x.amount||0);if(budgetMode==="paycheck"&&x.notes!=="per_paycheck")n=n*12/26;if(budgetMode==="monthly"&&x.notes==="per_paycheck")n=n*26/12;return n}
async function loadBudgetData(){const {data:{session}}=await sb.auth.getSession();if(!session){$("budgetDataStatus").textContent="Sign in is required before private budget records can sync.";renderBudget();return}const {data:rows,error}=await sb.from("budget_entries").select("*").order("entry_type");if(error){$("budgetDataStatus").textContent="Budget sync unavailable: "+error.message;budgetEntries=[]}else{$("budgetDataStatus").textContent="";budgetEntries=rows||[]}renderBudget()}
function budgetGroup(x){const n=(x.name||"").toLowerCase(),cat=(x.category||"").toLowerCase();if(x.entry_type==="goal"||n.includes("roth")||n.includes("401"))return "Savings";if(n.includes("toyota")||n.includes("geico")||cat.includes("transport")||cat.includes("auto")||cat.includes("insurance"))return "Auto";if(n.includes("chatgpt")||cat.includes("subscription"))return "Subscriptions";if(n.includes("rent")||n.includes("utility")||n.includes("internet")||n.includes("mediacom")||n.includes("gym")||cat.includes("housing")||cat.includes("utilities"))return "Living";return "Other"}
function budgetModel(){const income=budgetEntries.filter(x=>x.entry_type==="income").reduce((s,x)=>s+normalizeBudgetAmount(x),0),items=budgetEntries.filter(x=>x.entry_type!=="income").map(x=>({...x,_value:normalizeBudgetAmount(x),_group:budgetGroup(x)})).filter(x=>x._value>0),allocated=items.reduce((s,x)=>s+x._value,0),left=Math.max(0,income-allocated);return{income,items,allocated,left}}
function renderBudget(){const m=budgetModel();$("budgetIncome").textContent=money(m.income);$("budgetSpending").textContent=money(m.allocated);$("budgetAvailable").textContent=money(m.left);renderBudgetTable();renderBudgetFlow()}
function renderBudgetTable(){const m=budgetModel(),order=["Savings","Living","Auto","Subscriptions","Other"];const rows=m.items.sort((a,b)=>order.indexOf(a._group)-order.indexOf(b._group)||b._value-a._value);$("budgetTableBody").innerHTML=rows.length?rows.map(x=>`<tr><td><span class="budget-cat cat-${x._group.toLowerCase()}">${esc(x._group)}</span></td><td>${esc(x.name)}</td><td>${money(x._value)}</td><td>${m.income?(x._value/m.income*100).toFixed(1):"0.0"}%</td></tr>`).join(""):'<tr><td colspan="4">No private budget rows synced yet.</td></tr>'}
function renderBudgetFlow(){
 const root=$("budgetFlow");root.innerHTML="";const m=budgetModel();
 if(!m.income){root.innerHTML='<div class="budget-empty">Add an income baseline to build the Sankey diagram.</div>';return}
 if(!window.d3||!d3.sankey){root.innerHTML='<div class="budget-empty">Sankey library failed to load. Refresh the app.</div>';return}
 const order=["Savings","Living","Auto","Subscriptions","Other"];
 const groups=order.map(name=>({name,items:m.items.filter(x=>x._group===name)})).filter(g=>g.items.length);
 groups.forEach(g=>g.value=g.items.reduce((s,x)=>s+x._value,0));
 const nodes=[{id:"income",name:"Total Income",type:"source",value:m.income}];
 const links=[];
 groups.forEach(g=>{const gid="group:"+g.name;nodes.push({id:gid,name:g.name,type:"group",group:g.name,value:g.value});links.push({source:"income",target:gid,value:g.value,group:g.name});g.items.forEach((x,i)=>{const id=gid+":item:"+i;nodes.push({id,name:x.name,type:"item",group:g.name,value:x._value});links.push({source:gid,target:id,value:x._value,group:g.name})})});
 if(m.left>0){nodes.push({id:"leftover",name:"Left Over",type:"group",group:"Left Over",value:m.left});links.push({source:"income",target:"leftover",value:m.left,group:"Left Over"})}
 const W=1080,H=Math.max(680,560+Math.max(0,m.items.length-8)*34),left=180,right=785,top=24,bottom=24;
 const sankey=d3.sankey().nodeId(d=>d.id).nodeWidth(12).nodePadding(34).nodeAlign(d3.sankeyJustify).nodeSort((a,b)=>{const rank={"Savings":0,"Living":1,"Auto":2,"Subscriptions":3,"Other":4,"Left Over":5};const ag=a.type==="group"?rank[a.name]:(rank[a.group]??99),bg=b.type==="group"?rank[b.name]:(rank[b.group]??99);return ag-bg}).extent([[left,top],[right,H-bottom]]);
 const graph=sankey({nodes:nodes.map(d=>({...d})),links:links.map(d=>({...d}))});
 const svg=d3.create("svg").attr("viewBox",[0,0,W,H]).attr("class","sankey-svg sankey-d3").attr("role","img").attr("aria-label","Monthly income flowing through budget categories to individual allocations.");
 const colors={"Savings":"#22a06b","Living":"#3b82f6","Auto":"#f59e42","Subscriptions":"#9b5de5","Other":"#9ca3af","Left Over":"#ef6464"};
 svg.append("g").selectAll("path").data(graph.links).join("path").attr("d",d3.sankeyLinkHorizontal()).attr("fill","none").attr("stroke",d=>colors[d.group]||"#94a3b8").attr("stroke-opacity",.30).attr("stroke-width",d=>Math.max(1,d.width));
 const source=graph.nodes.find(n=>n.id==="income");
 svg.append("rect").attr("x",20).attr("y",source.y0).attr("width",150).attr("height",source.y1-source.y0).attr("rx",8).attr("fill","#1f2937");
 const sy=(source.y0+source.y1)/2;svg.append("text").attr("x",40).attr("y",sy-18).attr("class","sk-source-label").text("Total Income");svg.append("text").attr("x",40).attr("y",sy+12).attr("class","sk-source-value").text(money(m.income));svg.append("text").attr("x",40).attr("y",sy+34).attr("class","sk-source-sub").text(budgetMode==="monthly"?"monthly":"per paycheck");
 const nonSource=graph.nodes.filter(n=>n.id!=="income");
 svg.append("g").selectAll("rect").data(nonSource).join("rect").attr("x",d=>d.x0).attr("y",d=>d.y0).attr("width",d=>d.x1-d.x0).attr("height",d=>Math.max(2,d.y1-d.y0)).attr("rx",3).attr("fill",d=>colors[d.group]||"#94a3b8");
 const groupsOnly=graph.nodes.filter(n=>n.type==="group");
 const gl=svg.append("g");
 groupsOnly.forEach(d=>{const y=(d.y0+d.y1)/2,h=d.y1-d.y0,labelY=h<38?d.y0-9:y-3,valueY=h<38?d.y0+10:y+15;gl.append("text").attr("x",d.x1+12).attr("y",labelY).attr("class","sk-mid-label").text(d.name);gl.append("text").attr("x",d.x1+12).attr("y",valueY).attr("class","sk-mid-value").text(money(d.value)+" · "+(d.value/m.income*100).toFixed(1)+"%")});
 const items=graph.nodes.filter(n=>n.type==="item");
 const cards=svg.append("g");
 items.forEach(d=>{const cy=(d.y0+d.y1)/2,bh=Math.max(32,d.y1-d.y0),y=cy-bh/2,x=d.x1+12,w=270;cards.append("rect").attr("x",x).attr("y",y).attr("width",w).attr("height",bh).attr("rx",6).attr("class","sk-item");cards.append("rect").attr("x",x).attr("y",y).attr("width",7).attr("height",bh).attr("rx",3).attr("fill",colors[d.group]||"#94a3b8");cards.append("text").attr("x",x+18).attr("y",cy+4).attr("class","sk-item-label").text(d.name);cards.append("text").attr("x",x+w-12).attr("y",cy+4).attr("class","sk-item-value").text(money(d.value))});
 root.appendChild(svg.node())
}
$("budgetModeMonthly").onclick=()=>{budgetMode="monthly";$("budgetModeMonthly").classList.add("active");$("budgetModePaycheck").classList.remove("active");renderBudget()}
$("budgetModePaycheck").onclick=()=>{budgetMode="paycheck";$("budgetModePaycheck").classList.add("active");$("budgetModeMonthly").classList.remove("active");renderBudget()}
$("setupBudgetLockBtn").onclick=()=>$("budgetSetupDialog").showModal();$("pinUnlockBtn").onclick=()=>budgetConfigured()?$("budgetPinDialog").showModal():$("budgetSetupDialog").showModal();$("faceUnlockBtn").onclick=()=>faceUnlock().catch(e=>$("budgetLockStatus").textContent=e.message||"Face ID / passkey unlock failed.");$("lockBudgetBtn").onclick=lockBudget;
$("budgetSetupForm").addEventListener("submit",async e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();const a=$("budgetPinNew").value,b=$("budgetPinConfirm").value;if(a!==b){$("budgetPinConfirm").setCustomValidity("PINs do not match");$("budgetPinConfirm").reportValidity();return}$("budgetPinConfirm").setCustomValidity("");await setupBudgetPin(a);$("budgetSetupDialog").close();$("budgetSetupForm").reset();try{await setupPasskey();$("budgetLockStatus").textContent="PIN and Face ID / passkey are ready."}catch{$("budgetLockStatus").textContent="PIN is ready. Face ID / passkey setup is still available."}});
$("budgetPinForm").addEventListener("submit",async e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();if(await verifyBudgetPin($("budgetPinEntry").value)){$("budgetPinDialog").close();$("budgetPinForm").reset();$("budgetPinError").textContent="";await unlockBudget()}else $("budgetPinError").textContent="Incorrect PIN."});document.addEventListener("visibilitychange",()=>{if(document.hidden)lockBudget()});["pointerdown","keydown"].forEach(ev=>document.addEventListener(ev,()=>{if(currentPage==="budget")touchBudget()},{passive:true}));


async function loadDigestibles(){
 const {data:r,error}=await sb.from("digestibles").select("*").order("created_at",{ascending:true});
 if(error){showErr(error,"digestStatus");digestibles=[]}else digestibles=r||[];
 renderDigestibles();
}
function updateDigestStatusLabels(){document.querySelectorAll(".digest-status-tab").forEach(b=>{const completed=b.dataset.digestStatus==="completed";b.textContent=digestView==="books"?(completed?"Books I’ve Read":"Books to Read"):digestView==="movies"?(completed?"Movies I’ve Watched":"Movies to Watch"):(completed?"Animes I’ve Watched":"Animes to Watch")})}
function renderDigestibles(){
 updateDigestStatusLabels();
 const type=digestView==="books"?"book":digestView==="movies"?"movie":"anime",rows=digestibles.filter(x=>x.media_type===type&&x.status===digestStatusView);
 $("digestItems").innerHTML='<div class="digest-list">'+(rows.length?"":'<div class="card empty">Nothing here yet.</div>')+'</div>';
 const root=$("digestItems").querySelector(".digest-list");rows.forEach(x=>root.appendChild(digestCard(x)));
}
function digestCard(x){
 const el=document.createElement("button");el.className="digest-card";
 const rating=x.rating!=null?'<span class="digest-rating">'+esc(x.rating)+"/"+esc(x.rating_scale||5)+'</span>':"";
 el.innerHTML='<div><b>'+esc(x.title)+'</b><span>'+(x.media_type==="book"?"by ":x.media_type==="anime"?"Created by ":"Directed by ")+esc(x.creator||"Unknown")+'</span></div>'+rating+'<span class="chevron">⌄</span>';
 el.onclick=()=>openDigestDetail(x);return el;
}
function digestLink(url,label){return url?'<a class="digest-link" href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(label)+'</a>':""}
function openDigestDetail(x){
 $("digestDetailTitle").textContent=x.title;
 let html='<div class="digest-creator">'+(x.media_type==="book"?"Author":x.media_type==="anime"?"Creator":"Director")+': <b>'+esc(x.creator||"Unknown")+'</b></div>';
 if(x.rating!=null)html+='<div class="digest-big-rating">'+esc(x.rating)+' / '+esc(x.rating_scale||5)+'</div>';
 if(x.description)html+='<div class="digest-description">'+esc(x.description)+'</div>';
 if(x.review)html+='<div class="digest-review">'+esc(x.review)+'</div>';
 if(x.media_type==="book"){
   html+='<div class="digest-links">'+digestLink(x.amazon_url,"Amazon");
   if(x.free_audio_url)html+=digestLink(x.free_audio_url,"Free audiobook");
   if(x.spotify_url&&x.spotify_url!==x.free_audio_url)html+=digestLink(x.spotify_url,"Spotify");
   if(x.youtube_url&&x.youtube_url!==x.free_audio_url)html+=digestLink(x.youtube_url,"YouTube");
   html+='</div>';
 } else {
   html+='<div class="movie-facts"><div><span>Streaming</span><b>'+esc(x.streaming_service||"Not currently listed")+'</b></div><div class="rt-direct"><span>Rotten Tomatoes</span><b>'+((x.rotten_tomatoes_critics!=null)?x.rotten_tomatoes_critics+"% Critics":"—")+'</b><small>'+((x.rotten_tomatoes_audience!=null)?x.rotten_tomatoes_audience+"% Audience":"")+'</small></div></div>';
 }
 $("digestDetail").innerHTML=html;$("digestDetailDialog").showModal();
}
document.querySelectorAll(".digest-tab").forEach(b=>b.onclick=()=>{digestView=b.dataset.digestView;digestStatusView="queue";document.querySelectorAll(".digest-tab").forEach(z=>z.classList.toggle("active",z===b));document.querySelectorAll(".digest-status-tab").forEach(z=>z.classList.toggle("active",z.dataset.digestStatus==="queue"));renderDigestibles()});
document.querySelectorAll(".digest-status-tab").forEach(b=>b.onclick=()=>{digestStatusView=b.dataset.digestStatus;document.querySelectorAll(".digest-status-tab").forEach(z=>z.classList.toggle("active",z===b));renderDigestibles()});
$("closeDigestDetail").onclick=()=>$("digestDetailDialog").close();
$("digestAddClose").onclick=()=>$("digestAddDialog").close();$("digestAddCancel").onclick=()=>$("digestAddDialog").close();
$("digestAddForm").addEventListener("submit",async e=>{
 e.preventDefault();
 const row={media_type:$("digestAddType").value,status:$("digestAddStatus").value,title:$("digestAddTitle").value.trim(),creator:$("digestAddCreator").value.trim()||null,description:$("digestAddDescription").value.trim()||null};
 const {data:created,error}=await sb.from("digestibles").insert(row).select().single();
 if(error){showErr(error,"digestStatus");return}
 digestibles.push(created);digestView=created.media_type==="book"?"books":created.media_type==="movie"?"movies":"animes";digestStatusView=created.status;
 document.querySelectorAll(".digest-tab").forEach(z=>z.classList.toggle("active",z.dataset.digestView===digestView));
 document.querySelectorAll(".digest-status-tab").forEach(z=>z.classList.toggle("active",z.dataset.digestStatus===digestStatusView));
 $("digestAddDialog").close();$("digestAddForm").reset();if(currentPage==="digestibles")renderDigestibles();
});

function setPage(page){
 const primaryPages=["home","devices","todos","buy"];
 if(primaryPages.includes(page))lastPrimaryPage=page;
 else if(page==="reminders"&&primaryPages.includes(currentPage))shelfReturnPage=currentPage;
 currentPage=page;
 window.scrollTo({top:0,behavior:"instant"});document.querySelectorAll(".page-tab").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
 const special=["home","devices","drivers","reminders","todos","budget","digestibles","projects","project-detail","health","vehicle","ai"],isSpecial=special.includes(page);
 $("listsPage").hidden=isSpecial;
 special.forEach(p=>{const el=$(p==="project-detail"?"projectDetailPage":p+"Page");if(el)el.hidden=page!==p});
 $("backupBtn").style.display=isSpecial?"none":"";$("addBtn").style.display="";
 if(page==="home"){ $("pageTitle").textContent="Roggy";$("pageSubtitle").textContent="Your command center.";renderHome(); }
 else if(page==="devices"){ $("pageTitle").textContent="Devices";$("pageSubtitle").textContent="Live smart-home control.";$("addBtn").style.display="none";renderDevicesPage();loadSmartHome().catch(()=>{}) }
 else if(page==="ai"){ $("pageTitle").textContent="Local AI";$("pageSubtitle").textContent="A private conversation with your PC.";$("addBtn").style.display="none"; }
 else if(page==="projects"){ $("pageTitle").textContent="Projects";$("pageSubtitle").textContent="Everything with a finish line.";renderProjects(); }
 else if(page==="health"){ $("pageTitle").textContent="Health";$("pageSubtitle").textContent="Garmin-powered wellness."; $("addBtn").style.display="none"; }
 else if(page==="vehicle"){ $("pageTitle").textContent="Vehicle";$("pageSubtitle").textContent="Maintenance and ownership."; $("addBtn").style.display="none"; }
 else if(page==="drivers"){ $("pageTitle").textContent="Bad Drivers";$("pageSubtitle").textContent="Track observations and compare demographics.";loadDrivers() }
 else if(page==="reminders"){ $("pageTitle").textContent="Reminders";$("pageSubtitle").textContent="What is coming up.";loadReminders() }
 else if(page==="todos"){ $("pageTitle").textContent="Tasks";$("pageSubtitle").textContent="Things that need doing.";loadTodos() }
 else if(page==="digestibles"){ $("pageTitle").textContent="Digestibles";$("pageSubtitle").textContent="Books, movies, and anime worth consuming.";loadDigestibles() }
 else if(page==="budget"){ $("pageTitle").textContent="Budget 🔒";$("pageSubtitle").textContent="Private financial dashboard.";$("addBtn").style.display="none";lockBudget() }
 else {currentView="active";document.querySelectorAll(".sub-tab").forEach(z=>z.classList.toggle("active",z.dataset.view==="active"));renderLists()}
 $("moreToggle").checked=false;
 window.dispatchEvent(new CustomEvent("roggy-page",{detail:{page}}));
}
document.querySelectorAll(".page-tab").forEach(b=>b.onclick=()=>setPage(b.dataset.page));
$("remindersBackBtn").onclick=()=>setPage(shelfReturnPage||lastPrimaryPage||"home");
document.querySelectorAll("#listsPage .sub-tab").forEach(b=>b.onclick=()=>{currentView=b.dataset.view;document.querySelectorAll("#listsPage .sub-tab").forEach(z=>z.classList.toggle("active",z===b));renderLists()});
document.querySelectorAll(".driver-tab").forEach(b=>b.onclick=()=>{driverView=b.dataset.driverView;document.querySelectorAll(".driver-tab").forEach(z=>z.classList.toggle("active",z===b));$("driverOverview").hidden=driverView!=="overview";$("driverObservations").hidden=driverView!=="observations";renderDriverPage()});
document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{currentFilter=b.dataset.filter;document.querySelectorAll(".filter").forEach(z=>z.classList.toggle("active",z===b));renderLists()});
$("search").oninput=renderLists;$("sort").onchange=renderLists;
$("driverSearch").oninput=renderDriverList;$("driverSort").onchange=renderDriverList;
$("ratioDimension").onchange=()=>{renderRatioChart();renderAnalysis()};
function openAddLauncher(){$("addLauncherDialog").showModal()}
function closeAddLauncher(){$("addLauncherDialog").close()}
function launchAddTarget(target){
 closeAddLauncher();
 if(target==="buy"||target==="groceries"){const previous=currentPage;currentPage=target;openAddItem();currentPage=previous;setItemDestination(target);return}
 if(target==="todos"){$("todoForm").reset();$("todoDialog").showModal();setTimeout(()=>$("todoTitle").focus(),50);return}
 if(target==="digestibles"){$("digestAddForm").reset();$("digestAddType").value=digestView==="movies"?"movie":digestView==="animes"?"anime":"book";$("digestAddStatus").value=digestStatusView;$("digestAddDialog").showModal();setTimeout(()=>$("digestAddTitle").focus(),50);return}
 if(target==="drivers"){$("driverForm").reset();$("driverDialog").showModal();return}
 if(target==="projects"){$("projectForm").reset();$("projectDialog").showModal();return}
}
$("addBtn").onclick=openAddLauncher;
$("addLauncherClose").onclick=closeAddLauncher;$("addLauncherCancel").onclick=closeAddLauncher;
document.querySelectorAll("[data-add-target]").forEach(b=>b.onclick=()=>launchAddTarget(b.dataset.addTarget));

$("backupBtn").onclick=()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="roggy-lists-backup.json";a.click();URL.revokeObjectURL(a.href)};

const OWNER_USER_ID="9c1fcb62-644b-486a-9f87-36246e2e50de";
function isOwnerSession(session){return !!session?.user&&session.user.id===OWNER_USER_ID}
function setPrivacyGate(session){
 let gate=document.getElementById("privacyGate");
 if(!gate){gate=document.createElement("div");gate.id="privacyGate";gate.innerHTML='<div class="privacy-gate-card"><h2>Private Roggy OS</h2><p>This site is restricted to its owner.</p><button id="privacySignIn" type="button">Sign in with GitHub</button><small id="privacyGateStatus"></small></div>';document.body.appendChild(gate);document.getElementById("privacySignIn").onclick=()=>document.getElementById("authBtn").click()}
 const owner=isOwnerSession(session);gate.hidden=owner;document.documentElement.classList.toggle("privacy-locked",!owner);
 if(session&&!owner){const st=document.getElementById("privacyGateStatus");if(st)st.textContent="This account is not authorized."}
}
function reminderStart(x){return x.all_day&&x.start_date?new Date(x.start_date+"T00:00:00"):new Date(x.start_at)}
function reminderEnd(x){return x.all_day&&x.end_date?new Date(x.end_date+"T00:00:00"):new Date(x.end_at||x.start_at)}
function applyAuthSession(session){
 session=isOwnerSession(session)?session:null;
 const hadSession=smartHomeControlAllowed,hasSession=!!session,authIdentityChanged=hadSession!==hasSession;
 if(!session&&smartHomeStreamAbort)smartHomeStreamAbort.abort();
 if(!session&&smartHomeStreamRetry){clearTimeout(smartHomeStreamRetry);smartHomeStreamRetry=null}
 smartHomeControlAllowed=hasSession;smartHomeAccessToken=session?.access_token||"";
 if(!session){smartHomeLoaded=false;smartHomeUnavailable=false;smartHomeFailure=null;smartHomeState={devices:[],rooms:[],events:[],diagnostics:null};layneChatMessages=[];renderLayneChat()}
 setPrivacyGate(session);
 if(authIdentityChanged){reminderSessionVersion++;reminders=[];remindersLoaded=false;monitorEmails=[];monitorEmailMessage=session?"Loading monitored email…":"Sign in to view monitored email.";renderImportantEmails()}
 window.dispatchEvent(new CustomEvent("roggy-auth",{detail:{signedIn:hasSession}}));
 if(currentPage==="home"&&(authIdentityChanged||!smartHomeLoaded))renderHome();
 if(currentPage==="devices"&&(authIdentityChanged||!smartHomeLoaded)){renderDevicesPage();if(session)loadSmartHome({silent:true}).catch(()=>{})}
 $("authBtn").textContent=session?"Sign out":"Sign in";$("authBtn").title=session?.user?.email||"Sign in with GitHub"
}
async function finishOAuthRedirect(){const p=new URLSearchParams(location.search),code=p.get("code"),err=p.get("error_description")||p.get("error");if(err){$("status").textContent="Sign-in error: "+err;history.replaceState({},document.title,location.pathname);return}if(!code)return;const {data,error}=await sb.auth.exchangeCodeForSession(code);history.replaceState({},document.title,location.pathname);if(error){$("status").textContent="Sign-in error: "+error.message;applyAuthSession(null);return}applyAuthSession(data.session);$("status").textContent=""}
async function updateAuth(){const {data:{session},error}=await sb.auth.getSession();if(error)showErr(error);if(session&&!isOwnerSession(session)){await sb.auth.signOut({scope:"local"});applyAuthSession(null);return null}applyAuthSession(session);return session}
$("authBtn").onclick=async()=>{const {data:{session}}=await sb.auth.getSession();if(session){const {error}=await sb.auth.signOut({scope:"local"});if(error)showErr(error);else applyAuthSession(null);return}const {data,error}=await sb.auth.signInWithOAuth({provider:"github",options:{redirectTo:"https://garoggy.github.io/roggy-buy-list/",skipBrowserRedirect:true}});if(error){showErr(error);return}if(data?.url)window.location.assign(data.url);else $("status").textContent="Sign-in error: Supabase did not return an authorization URL."};
sb.auth.onAuthStateChange((event,session)=>{if(session&&!isOwnerSession(session)){setTimeout(()=>sb.auth.signOut({scope:"local"}),0);applyAuthSession(null);return}applyAuthSession(session);if(!session)return;setTimeout(()=>{loadLists();if(currentPage==="drivers")loadDrivers();if(currentPage==="reminders")loadReminders();if(typeof loadHomeTasks==="function")loadHomeTasks();if(currentPage==="budget"&&budgetUnlocked)loadBudgetData();if(currentPage==="digestibles")loadDigestibles()},0)});



/* Command center + personal OS v35 */
function renderHome(){
 $("homeDate").textContent=new Date().toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"});
 const now=new Date(),tomorrow=new Date(now);tomorrow.setHours(24,0,0,0);
 const allTodays=(reminders||[]).filter(x=>{const d=reminderStart(x),finish=reminderEnd(x);return d<tomorrow&&(finish>localDay(now)||d>=localDay(now))});
 const todays=allTodays.slice(0,4);
 const taskCount=(typeof todos!=="undefined"?todos:[]).filter(x=>x.status==="open").length;
 ensureBuiltinProjects();const projectCount=projects.filter(x=>!["Done","Completed"].includes(x.status)).length;
 if($("focusTaskCount"))$("focusTaskCount").textContent=String(taskCount);
 if($("focusTodayCount"))$("focusTodayCount").textContent=String(allTodays.length);
 if($("focusProjectCount"))$("focusProjectCount").textContent=String(projectCount);
 $("homeTimeline").innerHTML='<div class="section-head"><div><span class="eyebrow">TODAY</span><h3>Next up</h3></div><button class="text-action" data-home-jump="reminders">See all</button></div>'+(todays.length?todays.map(x=>'<button class="timeline-row" data-home-jump="reminders"><span>'+esc(x.all_day?"All day":new Date(x.start_at).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}))+'</span><b>'+esc(x.title)+'</b></button>').join(""):'<div class="quiet-state">Nothing demanding your attention right now.</div>');
 renderImportantEmails();
 renderHomeDeviceStatus();
 if(!smartHomeLoaded)loadSmartHome({silent:true}).catch(()=>{});
 document.querySelectorAll("[data-home-jump]").forEach(b=>b.onclick=()=>setPage(b.dataset.homeJump));
 document.querySelectorAll("[data-focus-jump]").forEach(b=>b.onclick=()=>setPage(b.dataset.focusJump));
 if(!remindersLoaded){remindersLoaded=true;loadReminders().then(()=>{if(currentPage==="home")renderHome()}).catch(()=>{})}
}
function renderImportantEmails(){
 if(!$("importantEmailList"))return;
 $("importantEmailList").innerHTML=monitorEmails.length?monitorEmails.map(x=>'<a class="important-email" href="https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(x.source_message_id)+'" target="_blank" rel="noopener noreferrer"><span class="email-kind">'+esc(x.category)+'</span><div><b>'+esc(x.subject)+'</b><small>'+esc(x.sender)+' · '+esc(x.summary)+'</small><small>'+esc(x.reason||"")+'</small></div><time>'+esc(new Date(x.timestamp).toLocaleDateString())+'</time></a>').join(""):'<div class="quiet-state">'+esc(monitorEmailMessage)+'</div>';
}
const BUILTIN_PROJECTS={
"Smart Home":{
 description:"Build a local-first apartment automation system that your AI can sense and control without relying on Alexa as the assistant.",
 steps:["Install Home Assistant or the chosen local automation service on the PC","Connect the Zigbee/Thread coordinator and pair sensors","Set up ATOM Voice units for room voice input","Pair presence/motion and door/window sensors","Connect dimmable smart lighting and validate API/local control","Add the SONOFF CAM-S2 to the local network and enable RTSP/ONVIF","Mount microphones/cameras with generalized mounts where needed","Expose safe device and camera controls to the local AI agent","Test voice → AI → device/camera actions and fallback behavior"],
 devices:[
  {name:"M5Stack ATOM Voice / Echo ×3",note:"Wall-powered room microphone/speaker nodes.",url:"https://shop.m5stack.com/products/atom-echo-smart-speaker-dev-kit"},
  {name:"Home Assistant Connect ZBT-1",note:"USB Zigbee coordinator for local sensors.",url:"https://www.home-assistant.io/connectzbt1"},
  {name:"Aqara Door & Window Sensors",note:"Zigbee contact sensors for doors/windows.",url:"https://www.aqara.com/us/product/door-and-window-sensor/"},
  {name:"Aqara Presence / Motion Sensor",note:"Presence sensing for room automations.",url:"https://www.aqara.com/us/product/sensor/"},
  {name:"Govee dimmable smart lighting",note:"Lighting controlled through supported Govee APIs/models.",url:"https://developer.govee.com/"},
  {name:"SONOFF CAM-S2 Indoor HD Camera",note:"1080p local AI vision camera with RTSP/ONVIF support.",url:"https://sonoff.tech/"},
  {name:"Generalized mounts",note:"Reusable desk/wall/table mounts for microphones, cameras and other smart-home hardware.",url:""}
 ]},
"Smart Car":{
 description:"Create a car telemetry system that records OBD-II and location data, then syncs trips and vehicle status back to your PC/app.",
 steps:["Plug the vLinker FD into the RAV4 OBD-II port","Build/configure the in-car bridge for automatic Bluetooth OBD connection","Add GNSS if you want independent trip/location logging","Cache trip data locally when the PC/phone is unavailable","Use the phone or Wi-Fi bridge to sync completed trips home","Add vehicle telemetry endpoints to the local AI/app","Test ignition, reconnect, unplug/replug and full-trip recording","Install dashcam separately; keep integration optional"],
 devices:[
  {name:"Vgate vLinker FD OBD-II adapter",note:"Bluetooth OBD-II telemetry source.",url:"https://www.vgatemall.com/products/vlinker-fd-bluetooth-obd2-scanner"},
  {name:"ESP32 development board",note:"Optional always-in-car bridge/data logger.",url:"https://www.espressif.com/en/products/devkits/esp32-devkitc/overview"},
  {name:"GNSS module",note:"Optional independent trip/location logging.",url:"https://www.adafruit.com/category/58"},
  {name:"Dashcam",note:"Separate recording system; integration is optional.",url:"https://www.garmin.com/en-US/c/automotive/dash-cams/"}
 ]}
};

async function loadProjectsFromSupabase(){
 const {data:{session}}=await sb.auth.getSession();
 if(!isOwnerSession(session)){ensureBuiltinProjects();return projects}
 const {data:rows,error}=await sb.from("projects").select("*").eq("user_id",session.user.id).order("created_at",{ascending:false});
 if(error){showErr(error);ensureBuiltinProjects();return projects}
 projects=(rows||[]).map(row=>({id:row.id,title:row.title,description:row.description||"",status:row.status||"active",priority:"High",created:row.created_at,builtin:!!BUILTIN_PROJECTS[row.title]}));
 saveProjects();return projects;
}
function ensureBuiltinProjects(){for(const [title,d] of Object.entries(BUILTIN_PROJECTS)){if(!projects.some(p=>p.title===title))projects.push({title,description:d.description,status:"Active",priority:"High",builtin:true,created:new Date().toISOString()})}saveProjects()}
async function renderProjects(){await loadProjectsFromSupabase();$("projectList").innerHTML=projects.map((p,i)=>'<button type="button" class="project-card project-open" data-project-open="'+i+'"><div><span class="project-status">'+esc(p.status)+'</span><h3>'+esc(p.title)+'</h3><p>'+esc(p.description||"No description yet.")+'</p></div><div class="project-foot"><span>'+esc(p.priority||"High")+' priority</span><span>Open →</span></div></button>').join("");document.querySelectorAll("[data-project-open]").forEach(b=>b.onclick=()=>openProject(+b.dataset.projectOpen))}
async function fetchProjectItems(title){
 const {data:{session}}=await sb.auth.getSession();
 if(!isOwnerSession(session))return [];
 const {data:projectRows,error:projectError}=await sb.from("projects").select("id").eq("title",title).eq("user_id",session.user.id).limit(1);
 if(projectError||!projectRows?.[0])return [];
 const {data:itemRows,error:itemError}=await sb.from("project_items").select("*").eq("project_id",projectRows[0].id).eq("user_id",session.user.id).order("created_at",{ascending:true});
 if(itemError)return [];
 return itemRows||[];
}
async function getProjectDbId(title){
 const p=projects.find(x=>x.title===title);if(p?.id)return p.id;
 const {data:{session}}=await sb.auth.getSession();if(!isOwnerSession(session))return null;
 const {data}=await sb.from("projects").select("id").eq("title",title).eq("user_id",session.user.id).limit(1);return data?.[0]?.id||null;
}
function projectCheckButton(checked,attrs,label){
 return '<button type="button" class="project-check '+(checked?'checked':'')+'" '+attrs+' aria-label="'+esc(label)+'" aria-pressed="'+(checked?'true':'false')+'">'+(checked?'✓':'')+'</button>';
}
async function toggleProjectItemCheck(id,next,title){
 const {error}=await sb.from("project_items").update({checked:next,updated_at:new Date().toISOString()}).eq("id",id);
 if(error){showErr(error);return}
 const i=projects.findIndex(p=>p.title===title);if(i>=0)openProject(i);
}
async function createAndCheckProjectItem(projectTitle,itemTitle,itemType,notes,url){
 const projectId=await getProjectDbId(projectTitle);if(!projectId){showErr(new Error("Project is not synced yet."));return}
 const {data:{session}}=await sb.auth.getSession();if(!isOwnerSession(session))return;
 const {error}=await sb.from("project_items").insert({project_id:projectId,user_id:session.user.id,title:itemTitle,item_type:itemType,status:"planned",notes:notes||null,product_url:url||null,checked:true});
 if(error){showErr(error);return}
 const i=projects.findIndex(p=>p.title===projectTitle);if(i>=0)openProject(i);
}
async function openProject(i){
 const p=projects[i];if(!p)return;const built=BUILTIN_PROJECTS[p.title];
 setPage("project-detail");$("pageTitle").textContent=p.title;$("pageSubtitle").textContent="Project";
 const dbItems=await fetchProjectItems(p.title);
 let html='';
 if(built){
   const byTitle=new Map(dbItems.map(x=>[x.title.toLowerCase(),x]));
   html+='<section class="project-detail-section"><h3>Implementation</h3><div class="project-check-list">'+built.steps.map((x,index)=>{const row=byTitle.get(x.toLowerCase());return '<div class="project-check-row">'+projectCheckButton(!!row?.checked,row?'data-project-item="'+esc(row.id)+'" data-project-item-title="'+esc(p.title)+'"':'data-project-step-create="'+index+'"','Toggle '+x)+'<div class="project-check-copy">'+esc(x)+'</div></div>'}).join("")+'</div></section>';
   const items=built.devices.map((d,index)=>{const row=byTitle.get(d.name.toLowerCase());return row?{...d,...row,name:row.title,note:row.notes||d.note,url:row.product_url||d.url,checked:!!row.checked}:{...d,requiredIndex:index}});
   dbItems.filter(row=>row.item_type!=="task"&&!items.some(x=>(x.id&&x.id===row.id)||x.name.toLowerCase()===row.title.toLowerCase())).forEach(row=>items.push({name:row.title,note:row.notes||"",url:row.product_url||"",id:row.id,checked:!!row.checked}));
   html+='<section class="project-detail-section"><h3>Devices / hardware</h3><div class="project-device-list">'+items.map(d=>'<div class="project-device project-device-checkable">'+projectCheckButton(!!d.checked,d.id?'data-project-item="'+esc(d.id)+'" data-project-item-title="'+esc(p.title)+'"':'data-project-device-create="'+d.requiredIndex+'"','Toggle '+d.name)+'<div class="project-device-copy"><b>'+esc(d.name)+'</b><p>'+esc(d.note||"")+'</p></div>'+(d.url?'<a class="project-device-link" href="'+esc(d.url)+'" target="_blank" rel="noopener" aria-label="Open '+esc(d.name)+' link">↗</a>':'')+'</div>').join("")+'</div></section>';
 } else {
   html+='<section class="project-detail-section"><h3>Items</h3><div class="project-device-list">'+(dbItems.length?dbItems.map(d=>'<div class="project-device project-device-checkable">'+projectCheckButton(!!d.checked,'data-project-item="'+esc(d.id)+'" data-project-item-title="'+esc(p.title)+'"','Toggle '+d.title)+'<div class="project-device-copy"><b>'+esc(d.title)+'</b><p>'+esc(d.notes||"")+'</p></div>'+(d.product_url?'<a class="project-device-link" href="'+esc(d.product_url)+'" target="_blank" rel="noopener" aria-label="Open '+esc(d.title)+' link">↗</a>':'')+'</div>').join(""):'<div class="quiet-state">No project items yet.</div>')+'</div></section>';
 }
 $("projectDetailContent").innerHTML=html;
 document.querySelectorAll("[data-project-item]").forEach(b=>b.onclick=()=>toggleProjectItemCheck(b.dataset.projectItem,b.getAttribute("aria-pressed")!=="true",b.dataset.projectItemTitle));
 document.querySelectorAll("[data-project-step-create]").forEach(b=>b.onclick=()=>{const step=built.steps[+b.dataset.projectStepCreate];createAndCheckProjectItem(p.title,step,"task","Required implementation step","")});
 document.querySelectorAll("[data-project-device-create]").forEach(b=>b.onclick=()=>{const d=built.devices[+b.dataset.projectDeviceCreate];createAndCheckProjectItem(p.title,d.name,"device",d.note,d.url)});
}
$("projectBackBtn").onclick=()=>setPage("projects");
$("newProjectBtn").onclick=()=>$("projectDialog").showModal();
$("projectForm").addEventListener("submit",async e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();const {data:{session}}=await sb.auth.getSession();if(!isOwnerSession(session))return;const row={user_id:session.user.id,title:$("projectTitle").value.trim(),description:$("projectDescription").value.trim()||null,status:String($("projectStatus").value||"Active").toLowerCase().replace(" ","_")};const {error}=await sb.from("projects").insert(row);if(error){showErr(error);return}$("projectForm").reset();$("projectDialog").close();await renderProjects()});
document.querySelectorAll(".command-card[data-jump]").forEach(b=>b.onclick=()=>setPage(b.dataset.jump));document.querySelectorAll("[data-focus-jump]").forEach(b=>b.onclick=()=>setPage(b.dataset.focusJump));
function openGlobalSearch(){$("globalSearchDialog").showModal();$("globalSearchInput").value="";renderGlobalSearch("");setTimeout(()=>$("globalSearchInput").focus(),50)}
$("globalSearchBtn").onclick=openGlobalSearch;$("closeGlobalSearch").onclick=()=>$("globalSearchDialog").close();
function renderGlobalSearch(q){q=q.toLowerCase().trim();let rows=[];(data.buy||[]).filter(x=>!x.deleted).forEach(x=>rows.push({type:"Buy",title:x.item,page:"buy"}));(data.groceries||[]).filter(x=>!x.deleted).forEach(x=>rows.push({type:"Grocery",title:x.item,page:"groceries"}));projects.forEach(x=>rows.push({type:"Project",title:x.title,page:"projects"}));(reminders||[]).forEach(x=>rows.push({type:"Reminder",title:x.title,page:"reminders"}));(digestibles||[]).forEach(x=>rows.push({type:x.media_type,title:x.title,page:"digestibles"}));if(q)rows=rows.filter(x=>(x.type+" "+x.title).toLowerCase().includes(q));else rows=rows.slice(0,8);$("globalSearchResults").innerHTML=rows.slice(0,30).map((x,i)=>'<button data-search-index="'+i+'"><span>'+esc(x.type)+'</span><b>'+esc(x.title)+'</b></button>').join("")||'<div class="quiet-state">No matches.</div>';document.querySelectorAll("[data-search-index]").forEach((b)=>b.onclick=()=>{$("globalSearchDialog").close();setPage(rows[+b.dataset.searchIndex].page)})}
$("globalSearchInput").oninput=e=>renderGlobalSearch(e.target.value);

/* Appearance settings v31 */
const THEME_KEY="roggy-theme",UI_SIZE_KEY="roggy-ui-size",COLOR_MODE_KEY="roggy-color-mode";
function applyAppearance(){
 const theme=localStorage.getItem(THEME_KEY)||"purple",size=localStorage.getItem(UI_SIZE_KEY)||"medium",mode=localStorage.getItem(COLOR_MODE_KEY)||"light";
 document.documentElement.dataset.theme=theme;document.documentElement.dataset.uiSize=size;document.documentElement.dataset.mode=mode;
 document.querySelectorAll(".color-choice").forEach(b=>b.classList.toggle("active",b.dataset.theme===theme));
 document.querySelectorAll(".size-choice").forEach(b=>b.classList.toggle("active",b.dataset.size===size));
 document.querySelectorAll(".mode-choice").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
 const swatch=document.querySelector('.color-choice[data-theme="'+theme+'"]');if(swatch){const color=swatch.style.getPropertyValue("--swatch");document.querySelector('meta[name="theme-color"]')?.setAttribute("content",color)}
}
applyAppearance();
document.querySelectorAll(".color-choice").forEach(b=>b.onclick=()=>{localStorage.setItem(THEME_KEY,b.dataset.theme);applyAppearance()});
document.querySelectorAll(".size-choice").forEach(b=>b.onclick=()=>{localStorage.setItem(UI_SIZE_KEY,b.dataset.size);applyAppearance()});
document.querySelectorAll(".mode-choice").forEach(b=>b.onclick=()=>{localStorage.setItem(COLOR_MODE_KEY,b.dataset.mode);applyAppearance()});
$("settingsShelfBtn").onclick=()=>{$("moreToggle").checked=false;$("settingsToggle").checked=true};

if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js");
updateAuth().then(async session=>{if(isOwnerSession(session)){await loadLists();if(typeof loadHomeTasks==="function")await loadHomeTasks()}if(currentPage==="reminders")setPage("home")});

/* UX pass v72 */
document.addEventListener("keydown",e=>{
 if(e.key==="Escape"){
   if($("moreToggle"))$("moreToggle").checked=false;
   if($("settingsToggle"))$("settingsToggle").checked=false;
   document.querySelectorAll("dialog[open]").forEach(d=>d.close());
 }
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();openGlobalSearch()}
});


/* Primary-page live panorama navigation v80 */
const PRIMARY_SWIPE_PAGES=["home","devices","todos","buy"];
let swipeStartX=0,swipeStartY=0,swipeLastX=0,swipeTracking=false,swipeAxis=null,swipeNeighbor=null,swipeNeighborPage=null,swipePointerId=null,swipeStartTime=0,swipeLastTime=0,swipeVelocityX=0;
let swipeVisualCurrent=null,swipeSettleTimer=null;
function ensureSwipeHUD(){
 if(document.querySelector(".swipe-hud"))return;
 const hud=document.createElement("div");hud.className="swipe-hud";hud.setAttribute("aria-hidden","true");
 hud.innerHTML='<span class="swipe-edge swipe-edge-left">‹</span><div class="swipe-dots">'+PRIMARY_SWIPE_PAGES.map((p,n)=>'<i data-swipe-dot="'+p+'" style="--dot-index:'+n+'"></i>').join("")+'</div><span class="swipe-edge swipe-edge-right">›</span><div class="swipe-progress-track"><b></b></div>';
 const tabs=document.querySelector(".page-tabs");if(tabs)tabs.appendChild(hud);updateSwipeHUD(currentPage);
}
function updateSwipeHUD(page=currentPage,progress=0,direction=0){
 const idx=PRIMARY_SWIPE_PAGES.indexOf(page);
 document.querySelectorAll("[data-swipe-dot]").forEach((d,n)=>d.classList.toggle("active",n===idx));
 document.documentElement.style.setProperty("--swipe-progress",Math.max(0,Math.min(1,progress)).toFixed(3));
 document.documentElement.style.setProperty("--swipe-dir",direction);
 document.documentElement.dataset.swipeFrom=page;
 document.documentElement.dataset.swipeDirection=direction>0?"next":direction<0?"prev":"idle";
 document.documentElement.classList.toggle("swipe-ready",progress>=1);
}
function swipeBlockedTarget(t){return !!t.closest("dialog,input,textarea,select,a,[contenteditable=true],.fab,.layne-chat-fab,.side-drawer")}
function primaryPageEl(page){
 if(page==="home")return $("homePage");if(page==="devices")return $("devicesPage");if(page==="todos")return $("todosPage");if(page==="buy")return $("listsPage");return null;
}
function mountainPagePosition(page=currentPage){
 const idx=PRIMARY_SWIPE_PAGES.indexOf(page);return idx<0?0:idx;
}
let mountainScrollY=window.scrollY||0;
function setMountainView(page=currentPage,dragPx=0){
 const idx=mountainPagePosition(page),viewportW=window.innerWidth||1,viewportH=window.innerHeight||1;
 // Use a modest slice of the panorama per page. Drag interpolation exactly matches
 // the eventual page position, so releasing a swipe never makes the image jump.
 const pageStep=viewportW*.28;
 const dragProgress=Math.max(-1.15,Math.min(1.15,dragPx/viewportW));
 const x=-(idx*pageStep)+(dragProgress*pageStep);
 // Vertical movement is intentionally slower than content scrolling.
 const y=-Math.min(Math.max(0,mountainScrollY)*.24,viewportH*.34);
 document.documentElement.style.setProperty("--panorama-x",x.toFixed(1)+"px");
 document.documentElement.style.setProperty("--panorama-y",y.toFixed(1)+"px");
}
function clearSwipeStyles(){
 [swipeVisualCurrent,primaryPageEl(currentPage),swipeNeighbor].filter(Boolean).forEach(el=>{el.classList.remove("swipe-panel","swipe-neighbor","swipe-animating");el.style.removeProperty("--panel-x");el.style.removeProperty("--swipe-opacity");});
 if(swipeNeighbor&&swipeNeighborPage!==currentPage)swipeNeighbor.hidden=true;
 swipeNeighbor=null;swipeNeighborPage=null;swipeVisualCurrent=null;document.documentElement.classList.remove("is-swiping","is-settling","swipe-ready");document.documentElement.dataset.swipeDirection="idle";
 updateSwipeHUD(currentPage,0,0);
}
function prepareSwipeNeighbor(direction){
 const idx=PRIMARY_SWIPE_PAGES.indexOf(currentPage),next=idx+direction;
 if(next<0||next>=PRIMARY_SWIPE_PAGES.length)return false;
 swipeNeighborPage=PRIMARY_SWIPE_PAGES[next];swipeNeighbor=primaryPageEl(swipeNeighborPage);
 if(!swipeNeighbor)return false;
 if(swipeNeighborPage==="devices"){renderDevicesPage();loadSmartHome({silent:true}).catch(()=>{})}
 else if(swipeNeighborPage==="todos")loadTodos();
 else if(swipeNeighborPage==="buy"){currentView="active";renderLists()}
 swipeNeighbor.hidden=false;swipeNeighbor.classList.add("swipe-panel","swipe-neighbor");
 return true;
}
function positionSwipePanels(dx){
 const tabs=document.querySelector(".page-tabs"),headerBottom=(tabs?.getBoundingClientRect().bottom||document.querySelector("header")?.getBoundingClientRect().bottom||0)+(parseFloat(getComputedStyle(tabs||document.documentElement).marginBottom)||0);
 document.documentElement.style.setProperty("--swipe-page-top",Math.max(0,headerBottom)+"px");
 const w=window.innerWidth||1,idx=PRIMARY_SWIPE_PAGES.indexOf(currentPage),direction=dx<0?1:-1,current=primaryPageEl(currentPage),progress=Math.min(1,Math.abs(dx)/(w*.25)); swipeVisualCurrent=current;updateSwipeHUD(currentPage,progress,direction);
 if(idx===0&&direction===-1){
   document.documentElement.classList.add("is-swiping");if(current){current.classList.add("swipe-panel");current.style.setProperty("--panel-x",Math.min(dx,w*.12)+"px")}
   setMountainView(currentPage,Math.min(dx,w*.12));return;
 }
 if(idx===PRIMARY_SWIPE_PAGES.length-1&&direction===1){
   if(current){current.classList.remove("swipe-panel");current.style.removeProperty("--panel-x")}setMountainView(currentPage,0);return;
 }
 if(!swipeNeighbor||swipeNeighborPage!==PRIMARY_SWIPE_PAGES[idx+direction]){
   if(swipeNeighbor&&swipeNeighborPage!==currentPage)swipeNeighbor.hidden=true;
   swipeNeighbor=null;swipeNeighborPage=null;if(!prepareSwipeNeighbor(direction))return;
 }
 document.documentElement.classList.add("is-swiping");
 if(current){current.classList.add("swipe-panel");current.style.setProperty("--panel-x",dx+"px");current.style.setProperty("--swipe-opacity",(1-Math.min(.08,Math.abs(dx)/w*.08)).toFixed(3))}
 if(swipeNeighbor){swipeNeighbor.style.setProperty("--panel-x",(dx+direction*w)+"px");swipeNeighbor.style.setProperty("--swipe-opacity",(.94+Math.min(.06,Math.abs(dx)/w*.06)).toFixed(3))}
 setMountainView(currentPage,dx);
}
function settleSwipe(commit,dx){
 const current=primaryPageEl(currentPage),w=window.innerWidth||1,direction=dx<0?1:-1;
 // Finger is up: leave drag mode BEFORE enabling transitions. Drag mode intentionally
 // disables transitions, so keeping it here made every release teleport.
 document.documentElement.classList.remove("is-swiping");document.documentElement.classList.add("is-settling");
 swipeVisualCurrent=current;[current,swipeNeighbor].filter(Boolean).forEach(el=>el.classList.add("swipe-animating"));
 if(commit&&swipeNeighbor){
   const target=swipeNeighborPage;
   // Logical navigation commits immediately on finger release so another swipe can
   // target the next page without waiting for the visual glide to finish.
   currentPage=target;updateSwipeHUD(target,1,direction);
   document.querySelectorAll(".page-tab").forEach(b=>b.classList.toggle("active",b.dataset.page===target));
   window.dispatchEvent(new CustomEvent("roggy-page",{detail:{page:target}}));
   // Keep the old/new DOM panels intact while their 420ms visual transition finishes.
   requestAnimationFrame(()=>requestAnimationFrame(()=>{
     if(current)current.style.setProperty("--panel-x",(-direction*w)+"px");
     swipeNeighbor.style.setProperty("--panel-x","0px");
     setMountainView(target,0);
   }));
   clearTimeout(swipeSettleTimer);swipeSettleTimer=setTimeout(()=>{
     const landed=swipeNeighbor;
     // The temporary incoming panel is fixed during the glide. Before removing that
     // shell, pin the real page to the exact same viewport position for one paint.
     // This prevents its normal document-flow top from producing a downward landing hop.
     if(landed){
       const r=landed.getBoundingClientRect();
       document.documentElement.style.setProperty("--swipe-land-top",r.top+"px");
       landed.classList.add("swipe-land-lock");
     }
     if(current&&current!==landed)current.hidden=true;
     if(landed){landed.classList.remove("swipe-neighbor","swipe-animating");landed.style.removeProperty("--panel-x");landed.style.removeProperty("--swipe-opacity")}
     swipeNeighbor=null;swipeNeighborPage=null;swipeVisualCurrent=null;
     document.documentElement.classList.remove("is-settling","is-swiping","swipe-ready");
     // Update state without setPage()'s scrollTo(0,0), which was causing a second layout jump.
     document.querySelectorAll(".page-tab").forEach(b=>b.classList.toggle("active",b.dataset.page===target));
     requestAnimationFrame(()=>requestAnimationFrame(()=>{
       if(landed){landed.classList.remove("swipe-panel","swipe-land-lock");landed.style.removeProperty("--panel-x")}
       document.documentElement.style.removeProperty("--swipe-land-top");
       updateSwipeHUD(target,0,0);setMountainView(target,0);
     }));
   },420);
 }else{
   updateSwipeHUD(currentPage,0,0);
   requestAnimationFrame(()=>requestAnimationFrame(()=>{
     if(current)current.style.setProperty("--panel-x","0px");
     if(swipeNeighbor)swipeNeighbor.style.setProperty("--panel-x",(direction*w)+"px");
     setMountainView(currentPage,0);
   }));
   clearTimeout(swipeSettleTimer);swipeSettleTimer=setTimeout(clearSwipeStyles,520);
 }
}
function finishSwipe(){
 if(!swipeTracking)return;
 const dx=swipeLastX-swipeStartX,idx=PRIMARY_SWIPE_PAGES.indexOf(currentPage),direction=dx<0?1:-1,threshold=(window.innerWidth||1)*.25,fastIntent=Math.abs(swipeVelocityX)>.72&&Math.abs(dx)>(window.innerWidth||1)*.14;
 swipeTracking=false;swipePointerId=null;
 if(swipeAxis==="x"&&idx===0&&direction===-1){
   const open=Math.abs(dx)>=threshold;clearSwipeStyles();setMountainView(currentPage,0);if(open)$("moreToggle").checked=true;
 }else if(swipeAxis==="x"&&idx===PRIMARY_SWIPE_PAGES.length-1&&direction===1){
   clearSwipeStyles();setMountainView(currentPage,0);
 }else if(swipeAxis==="x")settleSwipe(Math.abs(dx)>=threshold||fastIntent,dx);
 else{clearSwipeStyles();setMountainView(currentPage,0)}
 swipeAxis=null;
}
function beginPrimarySwipe(x,y,target,pointerId=null){
 if(swipeBlockedTarget(target)||!PRIMARY_SWIPE_PAGES.includes(currentPage))return false;
 if(document.documentElement.classList.contains("is-settling")){
   clearTimeout(swipeSettleTimer);
   [swipeVisualCurrent,swipeNeighbor].filter(Boolean).forEach(el=>{el.classList.remove("swipe-panel","swipe-neighbor","swipe-animating");el.style.removeProperty("--panel-x")});
   document.querySelectorAll("#homePage,#devicesPage,#todosPage,#listsPage").forEach(el=>el.hidden=el!==primaryPageEl(currentPage));
   swipeNeighbor=null;swipeNeighborPage=null;swipeVisualCurrent=null;document.documentElement.classList.remove("is-settling");
 }
 clearSwipeStyles();swipeStartX=swipeLastX=x;swipeStartY=y;swipeStartTime=swipeLastTime=performance.now();swipeVelocityX=0;swipeTracking=true;swipeAxis=null;swipePointerId=pointerId;return true;
}
function movePrimarySwipe(x,y){
 if(!swipeTracking)return false;
 const dx=x-swipeStartX,dy=y-swipeStartY;
 if(!swipeAxis&&Math.hypot(dx,dy)>8)swipeAxis=Math.abs(dx)>Math.abs(dy)*1.12?"x":"y";
 if(swipeAxis!=="x")return false;
 const now=performance.now(),dt=Math.max(1,now-swipeLastTime);swipeVelocityX=(swipeVelocityX*.58)+(((x-swipeLastX)/dt)*.42);swipeLastTime=now;swipeLastX=x;positionSwipePanels(dx);return true;
}
// Native touch events are more reliable on iOS when a swipe begins over tab/button surfaces.
document.addEventListener("touchstart",e=>{
 if(e.touches.length!==1)return;
 const t=e.touches[0];beginPrimarySwipe(t.clientX,t.clientY,e.target,"touch");
},{passive:true});
document.addEventListener("touchmove",e=>{
 if(!swipeTracking||swipePointerId!=="touch"||e.touches.length!==1)return;
 const t=e.touches[0];if(movePrimarySwipe(t.clientX,t.clientY))e.preventDefault();
},{passive:false});
document.addEventListener("touchend",()=>{if(swipeTracking&&swipePointerId==="touch")finishSwipe()},{passive:true});
document.addEventListener("touchcancel",()=>{if(swipeTracking&&swipePointerId==="touch"){swipeTracking=false;swipeAxis=null;swipePointerId=null;settleSwipe(false,0)}},{passive:true});
// Pointer handling remains for desktop mouse/trackpad testing, but touch is handled above.
document.addEventListener("pointerdown",e=>{
 if(e.pointerType!=="mouse"||e.button!==0)return;
 beginPrimarySwipe(e.clientX,e.clientY,e.target,e.pointerId);
},{passive:true});
document.addEventListener("pointermove",e=>{
 if(!swipeTracking||e.pointerType!=="mouse"||e.pointerId!==swipePointerId)return;
 if(movePrimarySwipe(e.clientX,e.clientY))e.preventDefault();
},{passive:false});
document.addEventListener("pointerup",e=>{if(swipeTracking&&e.pointerType==="mouse"&&e.pointerId===swipePointerId)finishSwipe()},{passive:true});
document.addEventListener("pointercancel",e=>{if(swipeTracking&&e.pointerType==="mouse"&&e.pointerId===swipePointerId){swipeTracking=false;swipeAxis=null;swipePointerId=null;settleSwipe(false,0)}},{passive:true});
window.addEventListener("roggy-page",e=>setMountainView(e.detail.page,0));
ensureSwipeHUD();setMountainView(currentPage,0);
window.addEventListener("resize",()=>setMountainView(currentPage,0));
let mountainScrollRAF=0;
window.addEventListener("scroll",()=>{
 mountainScrollY=window.scrollY||document.documentElement.scrollTop||0;
 if(mountainScrollRAF)return;
 mountainScrollRAF=requestAnimationFrame(()=>{mountainScrollRAF=0;if(!swipeTracking)setMountainView(currentPage,0)});
},{passive:true});
