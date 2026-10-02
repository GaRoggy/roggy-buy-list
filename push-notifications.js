/* Generic, user-initiated Web Push support for the Roggy Lists PWA. */
const ROGGY_PUSH_PUBLIC_KEY = 'BFk1zAfmm9mMTfQ7asu4LoXVNfNlm0wn2JkhEUnC62SWRdtovEha2o2C6tetp7IQw0Nle7MkGqeHBhcy9H4nkxU';
const ROGGY_PUSH_FUNCTION = 'push-notifications';
const ROGGY_PUSH_STATE = { registration: null, subscription: null, session: null, busy: false };

function roggyPushElement(id){return document.getElementById(id)}
function roggyPushSetStatus(message, note=''){
  const status=roggyPushElement('pushStatus'), support=roggyPushElement('pushSupportNote');
  if(status)status.textContent=message;
  if(support)support.textContent=note;
}
function roggyPushIsStandalone(){return window.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone===true}
function roggyPushSupport(){
  if(!window.isSecureContext)return {ok:false,message:'Unsupported on this device/browser.',note:'Notifications require a secure HTTPS connection.'};
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||typeof Notification==='undefined')return {ok:false,message:'Unsupported on this device/browser.',note:'This browser does not provide the required push APIs.'};
  if(/iPad|iPhone|iPod/.test(navigator.userAgent)&&!roggyPushIsStandalone())return {ok:false,message:'Install Roggy Lists to enable notifications.',note:'On iPhone or iPad, add Roggy Lists to the Home Screen and open it there first.'};
  if(!ROGGY_PUSH_PUBLIC_KEY||ROGGY_PUSH_PUBLIC_KEY.startsWith('__'))return {ok:false,message:'Notifications are not configured yet.',note:'The public push key has not been configured.'};
  return {ok:true};
}
function roggyPushBase64ToBytes(value){
  const padding='='.repeat((4-value.length%4)%4),base64=(value+padding).replaceAll('-','+').replaceAll('_','/');
  const raw=atob(base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;
}
function roggyPushSafeLocalUrl(value){
  const base=new URL('./',location.href);let candidate;
  try{candidate=new URL(typeof value==='string'&&value?value:'./',base)}catch{return base.pathname}
  if(candidate.origin!==location.origin||!candidate.pathname.startsWith(base.pathname))return base.pathname;
  return `${candidate.pathname}${candidate.search}${candidate.hash}`;
}
async function roggyPushEnsureRegistration(){
  if(!ROGGY_PUSH_STATE.registration)ROGGY_PUSH_STATE.registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
  return ROGGY_PUSH_STATE.registration;
}
async function roggyPushSession(){
  if(typeof sb==='undefined')return null;
  const {data}=await sb.auth.getSession();return data?.session&&typeof isOwnerSession==='function'&&isOwnerSession(data.session)?data.session:null;
}
async function roggyPushInvoke(body){
  if(typeof sb==='undefined')throw new Error('Authentication is unavailable.');
  const {data,error}=await sb.functions.invoke(ROGGY_PUSH_FUNCTION,{body});
  if(error)throw error;
  if(data?.ok===false)throw new Error(data.error||'Push service rejected the request.');
  return data||{};
}
function roggyPushPayload(subscription){
  const json=subscription.toJSON();
  return {endpoint:json.endpoint,keys:json.keys,userAgent:navigator.userAgent.slice(0,512),deviceLabel:/iPhone|iPad|iPod/.test(navigator.userAgent)?'iPhone or iPad':'Web browser'};
}
async function roggyPushSyncSubscription(subscription){
  if(!ROGGY_PUSH_STATE.session||!subscription)return;
  await roggyPushInvoke({action:'subscribe',subscription:roggyPushPayload(subscription)});
}
function roggyPushRender(){
  const support=roggyPushSupport(),enable=roggyPushElement('pushEnable'),test=roggyPushElement('pushTest'),disable=roggyPushElement('pushDisable');
  if(!support.ok){roggyPushSetStatus(support.message,support.note);if(enable)enable.hidden=true;if(test)test.hidden=true;if(disable)disable.hidden=true;return}
  if(!ROGGY_PUSH_STATE.session){roggyPushSetStatus('Sign in to enable notifications.','Notifications are tied to your Roggy Lists account.');if(enable)enable.hidden=false;if(test)test.hidden=true;if(disable)disable.hidden=true;return}
  const permission=Notification.permission;
  if(ROGGY_PUSH_STATE.subscription){roggyPushSetStatus('Enabled on this device.','This device can receive Roggy Lists test notifications.');if(enable)enable.hidden=true;if(test)test.hidden=false;if(disable)disable.hidden=false;return}
  if(permission==='denied'){roggyPushSetStatus('Permission denied.','Allow notifications for Roggy Lists in this browser’s site settings, then try again.');if(enable)enable.hidden=false;if(test)test.hidden=true;if(disable)disable.hidden=true;return}
  roggyPushSetStatus('Not enabled.','Notifications are requested only after you press Enable Notifications.');if(enable)enable.hidden=false;if(test)test.hidden=true;if(disable)disable.hidden=true;
}
async function roggyPushRefresh(){
  const support=roggyPushSupport();
  if(!support.ok){roggyPushRender();return}
  try{
    await roggyPushEnsureRegistration();
    ROGGY_PUSH_STATE.session=await roggyPushSession();
    ROGGY_PUSH_STATE.subscription=await ROGGY_PUSH_STATE.registration.pushManager.getSubscription();
    if(ROGGY_PUSH_STATE.subscription&&ROGGY_PUSH_STATE.session)await roggyPushSyncSubscription(ROGGY_PUSH_STATE.subscription);
  }catch(error){console.warn('push_setup_failed',error?.name||'error');roggyPushSetStatus('Notifications unavailable.','The service worker or push service could not be reached.');return}
  roggyPushRender();
}
async function roggyPushEnable(){
  if(ROGGY_PUSH_STATE.busy)return;ROGGY_PUSH_STATE.busy=true;
  try{
    const support=roggyPushSupport();if(!support.ok){roggyPushRender();return}
    ROGGY_PUSH_STATE.session=await roggyPushSession();if(!ROGGY_PUSH_STATE.session){roggyPushRender();return}
    const permission=await Notification.requestPermission();
    if(permission!=='granted'){roggyPushRender();return}
    const registration=await roggyPushEnsureRegistration();
    ROGGY_PUSH_STATE.subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:roggyPushBase64ToBytes(ROGGY_PUSH_PUBLIC_KEY)});
    await roggyPushSyncSubscription(ROGGY_PUSH_STATE.subscription);
  }catch(error){console.warn('push_enable_failed',error?.name||'error');ROGGY_PUSH_STATE.subscription=null;roggyPushSetStatus('Could not enable notifications.','Check your connection and try again from Settings.');return}
  finally{ROGGY_PUSH_STATE.busy=false}
  roggyPushRender();
}
async function roggyPushDisable(){
  if(ROGGY_PUSH_STATE.busy||!ROGGY_PUSH_STATE.subscription)return;ROGGY_PUSH_STATE.busy=true;
  try{
    ROGGY_PUSH_STATE.session=await roggyPushSession();
    if(ROGGY_PUSH_STATE.session)await roggyPushInvoke({action:'unsubscribe',endpoint:ROGGY_PUSH_STATE.subscription.endpoint});
    await ROGGY_PUSH_STATE.subscription.unsubscribe();ROGGY_PUSH_STATE.subscription=null;
  }catch(error){console.warn('push_disable_failed',error?.name||'error');roggyPushSetStatus('Could not disable this device.','Try again when Roggy Lists is online.');return}
  finally{ROGGY_PUSH_STATE.busy=false}
  roggyPushRender();
}
async function roggyPushTest(){
  if(ROGGY_PUSH_STATE.busy)return;ROGGY_PUSH_STATE.busy=true;
  try{
    const result=await roggyPushInvoke({action:'send_test'});
    roggyPushSetStatus(result.sent?'Test notification sent.':'No active subscription found.','The test uses only the generic push channel.');
  }catch(error){console.warn('push_test_failed',error?.name||'error');roggyPushSetStatus('Test notification failed.','The push backend or subscription may be unavailable.');}
  finally{ROGGY_PUSH_STATE.busy=false}
}
function roggyPushInit(){
  roggyPushElement('pushEnable')?.addEventListener('click',roggyPushEnable);
  roggyPushElement('pushDisable')?.addEventListener('click',roggyPushDisable);
  roggyPushElement('pushTest')?.addEventListener('click',roggyPushTest);
  window.addEventListener('roggy-auth',()=>roggyPushRefresh().catch(()=>{}));
  roggyPushRefresh().catch(()=>{});
}
window.roggyPush={refresh:roggyPushRefresh,enable:roggyPushEnable,disable:roggyPushDisable,test:roggyPushTest};
roggyPushInit();
