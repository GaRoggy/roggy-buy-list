/* Generic, user-initiated Web Push support for the Roggy Lists PWA. */
const ROGGY_PUSH_PUBLIC_KEY = 'BFk1zAfmm9mMTfQ7asu4LoXVNfNlm0wn2JkhEUnC62SWRdtovEha2o2C6tetp7IQw0Nle7MkGqeHBhcy9H4nkxU';
const ROGGY_PUSH_FUNCTION = 'push-notifications';
const ROGGY_PUSH_DIAGNOSTICS_KEY = 'roggy-push-diagnostics-v1';
const ROGGY_PUSH_STATE = {
  registration: null, subscription: null, session: null, busy: false,
  support: null, permission: 'unknown', serviceWorker: 'unknown',
  backendRegistration: 'unknown', backend: 'unknown', failureStage: null,
  lastAttempt: null, lastResult: 'not_run', lastError: null,
};

function roggyPushElement(id){return document.getElementById(id)}
function roggyPushSafeJson(value){try{return JSON.stringify(value,null,2)}catch{return String(value)}}
function roggyPushReadHistory(){
  try{
    const value=JSON.parse(localStorage.getItem(ROGGY_PUSH_DIAGNOSTICS_KEY)||'null');
    if(value&&typeof value==='object'){
      ROGGY_PUSH_STATE.lastAttempt=typeof value.lastAttempt==='string'?value.lastAttempt:null;
      ROGGY_PUSH_STATE.lastResult=typeof value.lastResult==='string'?value.lastResult:'not_run';
      ROGGY_PUSH_STATE.failureStage=typeof value.failureStage==='string'?value.failureStage:null;
      ROGGY_PUSH_STATE.lastError=value.lastError&&typeof value.lastError==='object'?value.lastError:null;
    }
  }catch{}
}
function roggyPushWriteHistory(){
  try{localStorage.setItem(ROGGY_PUSH_DIAGNOSTICS_KEY,JSON.stringify({lastAttempt:ROGGY_PUSH_STATE.lastAttempt,lastResult:ROGGY_PUSH_STATE.lastResult,failureStage:ROGGY_PUSH_STATE.failureStage,lastError:ROGGY_PUSH_STATE.lastError}))}catch{}
}
function roggyPushSetStatus(message,note=''){
  const status=roggyPushElement('pushStatus'),support=roggyPushElement('pushSupportNote');
  if(status)status.textContent=message;
  if(support)support.textContent=note;
}
function roggyPushSetDiagnostic(id,value){const element=roggyPushElement(id);if(element)element.textContent=value}
function roggyPushIsStandalone(){return window.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone===true}
function roggyPushSupport(){
  if(!window.isSecureContext)return {ok:false,message:'Unsupported on this device/browser.',note:'Notifications require a secure HTTPS connection.',stage:'browser'};
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||typeof Notification==='undefined')return {ok:false,message:'Unsupported on this device/browser.',note:'This browser does not provide the required push APIs.',stage:'browser'};
  if(/iPad|iPhone|iPod/.test(navigator.userAgent)&&!roggyPushIsStandalone())return {ok:false,message:'Install Roggy Lists to enable notifications.',note:'On iPhone or iPad, add Roggy Lists to the Home Screen and open it there first.',stage:'browser'};
  if(!ROGGY_PUSH_PUBLIC_KEY||ROGGY_PUSH_PUBLIC_KEY.startsWith('__'))return {ok:false,message:'Notifications are not configured yet.',note:'The public push key has not been configured.',stage:'configuration'};
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
async function roggyPushWithTimeout(promise,ms,label){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{const error=new Error(label);error.name='TimeoutError';reject(error)},ms)})])}
  finally{clearTimeout(timer)}
}
async function roggyPushEnsureRegistration(){
  if(!ROGGY_PUSH_STATE.registration)ROGGY_PUSH_STATE.registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
  const ready=await roggyPushWithTimeout(navigator.serviceWorker.ready,12000,'Service worker ready timeout');
  if(!ready?.active)throw Object.assign(new Error('Service worker has no active worker.'),{name:'ServiceWorkerInactive'});
  ROGGY_PUSH_STATE.registration=ready;ROGGY_PUSH_STATE.serviceWorker='active';return ready;
}
async function roggyPushSession(){
  if(typeof sb==='undefined')return null;
  const {data}=await sb.auth.getSession();return data?.session&&typeof isOwnerSession==='function'&&isOwnerSession(data.session)?data.session:null;
}
function roggyPushErrorFromResponse(code,message,detail){const error=new Error(message||code||'Push request failed.');error.code=code||'PUSH_REQUEST_FAILED';error.detail=detail||null;return error}
async function roggyPushInvoke(body){
  if(typeof sb==='undefined')throw roggyPushErrorFromResponse('AUTHENTICATION_UNAVAILABLE','Layne is not signed in.');
  const {data,error}=await sb.functions.invoke(ROGGY_PUSH_FUNCTION,{body});
  if(error){
    let detail=null;
    try{if(error.context&&typeof error.context.clone==='function')detail=await error.context.clone().json()}catch{}
    const payload=detail?.error_detail||detail;
    throw roggyPushErrorFromResponse(payload?.error_code||payload?.code||error.name||'PUSH_REQUEST_FAILED',payload?.message||error.message,payload);
  }
  if(data?.ok===false)throw roggyPushErrorFromResponse(data.error_code||data.code||'PUSH_REQUEST_FAILED',data.message||data.error,data);
  return data||{};
}
function roggyPushPayload(subscription){
  const json=subscription.toJSON();
  return {endpoint:json.endpoint,keys:json.keys,userAgent:navigator.userAgent.slice(0,512),deviceLabel:/iPhone|iPad|iPod/.test(navigator.userAgent)?'iPhone or iPad':'Web browser'};
}
function roggyPushSubscriptionIsValid(subscription){const json=subscription?.toJSON?.();return !!(json?.endpoint&&/^https:\/\//i.test(json.endpoint)&&json?.keys?.p256dh&&json?.keys?.auth)}
async function roggyPushSyncSubscription(subscription){if(!ROGGY_PUSH_STATE.session||!subscription)return null;return await roggyPushInvoke({action:'subscribe',subscription:roggyPushPayload(subscription)})}
function roggyPushFormatError(error){
  const code=error?.code||'PUSH_REQUEST_FAILED';
  const messages={
    NO_ACTIVE_SUBSCRIPTION:['No active subscription is registered for this account.','Enable notifications on this device, then try again.','subscription'],
    SUBSCRIPTION_NOT_REGISTERED:['This browser has a subscription, but Layne does not have it registered.','Enable notifications again to repair this device registration.','registration'],
    SUBSCRIPTION_DISABLED:['Layne found this device, but its subscription was disabled after repeated failures.','Enable notifications again to re-enable this device.','registration'],
    PUSH_SUBSCRIPTION_EXPIRED:['The push provider rejected this subscription as expired.','The dead subscription was removed. Enable notifications again on this device.','provider'],
    PUSH_AUTH_REJECTED:['The push provider rejected Layne’s authentication credentials.','The backend needs its VAPID credentials corrected.','credentials'],
    PUSH_SUBSCRIPTION_INVALID:['The push provider rejected this device subscription as invalid.','Enable notifications again to create a fresh subscription.','provider'],
    PUSH_PROVIDER_TIMEOUT:['The push provider timed out before accepting the notification.','Try again in a moment.','provider'],
    PUSH_PROVIDER_ERROR:['The push provider rejected the notification.','See technical details for the bounded provider response.','provider'],
    PUSH_CONFIGURATION_MISSING:['Layne’s push backend is missing its VAPID configuration.','The backend must be configured before notifications can be sent.','credentials'],
    PUSH_CONFIGURATION_INVALID:['Layne’s push backend has invalid VAPID configuration.','The backend credentials must be regenerated or corrected.','credentials'],
    DATABASE_UNAVAILABLE:['Layne’s push backend could not reach its subscription store.','Try again when the backend is online.','backend'],
    DATABASE_TIMEOUT:['Layne’s push backend timed out reading its subscription store.','Try again in a moment.','backend'],
    AUTHENTICATION_REQUIRED:['Layne’s session is no longer valid.','Sign in again, then retry notifications.','authentication'],
  };
  const match=messages[code]||['The notification backend could not complete the request.','See technical details for the bounded failure stage.','backend'];
  return {code,message:match[0],note:match[1],stage:match[2],detail:error?.detail||null};
}
function roggyPushRenderDiagnostics(){
  const support=ROGGY_PUSH_STATE.support||{};
  roggyPushSetDiagnostic('pushDiagnosticPermission',ROGGY_PUSH_STATE.permission==='granted'?'Granted':ROGGY_PUSH_STATE.permission==='denied'?'Denied':ROGGY_PUSH_STATE.permission==='default'?'Default':'Unavailable');
  roggyPushSetDiagnostic('pushDiagnosticServiceWorker',ROGGY_PUSH_STATE.serviceWorker==='active'?'Active':ROGGY_PUSH_STATE.serviceWorker==='missing'?'Missing':ROGGY_PUSH_STATE.serviceWorker==='error'?'Error':'Checking…');
  roggyPushSetDiagnostic('pushDiagnosticLocalSubscription',ROGGY_PUSH_STATE.subscription?'Active':'Missing');
  roggyPushSetDiagnostic('pushDiagnosticBackendRegistration',ROGGY_PUSH_STATE.backendRegistration==='active'?'Active':ROGGY_PUSH_STATE.backendRegistration==='disabled'?'Disabled':ROGGY_PUSH_STATE.backendRegistration==='missing'?'Missing':ROGGY_PUSH_STATE.backendRegistration==='error'?'Error':'Checking…');
  roggyPushSetDiagnostic('pushDiagnosticBackend',ROGGY_PUSH_STATE.backend==='healthy'?'Healthy':ROGGY_PUSH_STATE.backend==='error'?'Error':'Checking…');
  roggyPushSetDiagnostic('pushDiagnosticLastAttempt',ROGGY_PUSH_STATE.lastAttempt?new Date(ROGGY_PUSH_STATE.lastAttempt).toLocaleString():'Never');
  roggyPushSetDiagnostic('pushDiagnosticLastResult',ROGGY_PUSH_STATE.lastResult==='success'?'Success':ROGGY_PUSH_STATE.lastResult==='failure'?'Failure':'Not run');
  roggyPushSetDiagnostic('pushDiagnosticFailureStage',ROGGY_PUSH_STATE.failureStage||'—');
  const technical={support:{secureContext:!!window.isSecureContext,serviceWorker:'serviceWorker' in navigator,pushManager:'PushManager' in window,notificationApi:typeof Notification!=='undefined',standalone:roggyPushIsStandalone(),iPhone:/iPad|iPhone|iPod/.test(navigator.userAgent)},permission:ROGGY_PUSH_STATE.permission,serviceWorker:ROGGY_PUSH_STATE.serviceWorker,localSubscription:!!ROGGY_PUSH_STATE.subscription,backendRegistration:ROGGY_PUSH_STATE.backendRegistration,pushBackend:ROGGY_PUSH_STATE.backend,lastAttempt:ROGGY_PUSH_STATE.lastAttempt,lastResult:ROGGY_PUSH_STATE.lastResult,failureStage:ROGGY_PUSH_STATE.failureStage,error:ROGGY_PUSH_STATE.lastError};
  const details=roggyPushElement('pushDiagnosticDetails');if(details)details.textContent=roggyPushSafeJson(technical);
  const diagnostics=roggyPushElement('pushDiagnostics');if(diagnostics)diagnostics.hidden=!support.ok;
}
function roggyPushRender(){
  const support=ROGGY_PUSH_STATE.support||roggyPushSupport(),enable=roggyPushElement('pushEnable'),test=roggyPushElement('pushTest'),disable=roggyPushElement('pushDisable');roggyPushRenderDiagnostics();
  if(!support.ok){roggyPushSetStatus(support.message,support.note);if(enable)enable.hidden=true;if(test)test.hidden=true;if(disable)disable.hidden=true;return}
  if(!ROGGY_PUSH_STATE.session){roggyPushSetStatus('Sign in to enable notifications.','Notifications are tied to your Roggy Lists account.');if(enable)enable.hidden=false;if(test)test.hidden=true;if(disable)disable.hidden=true;return}
  if(ROGGY_PUSH_STATE.subscription){roggyPushSetStatus('Enabled on this device.','This device can receive Roggy Lists test notifications.');if(enable)enable.hidden=true;if(test)test.hidden=false;if(disable)disable.hidden=false;return}
  if(ROGGY_PUSH_STATE.permission==='denied'){roggyPushSetStatus('Permission denied.','Allow notifications for Roggy Lists in this browser’s site settings, then try again.');if(enable)enable.hidden=false;if(test)test.hidden=true;if(disable)disable.hidden=true;return}
  roggyPushSetStatus('Not enabled.','Notifications are requested only after you press Enable Notifications.');if(enable)enable.hidden=false;if(test)test.hidden=true;if(disable)disable.hidden=true;
}
async function roggyPushRefresh(){
  ROGGY_PUSH_STATE.support=roggyPushSupport();ROGGY_PUSH_STATE.permission=typeof Notification==='undefined'?'unavailable':Notification.permission;ROGGY_PUSH_STATE.session=await roggyPushSession();
  if(!ROGGY_PUSH_STATE.support.ok){ROGGY_PUSH_STATE.serviceWorker='missing';ROGGY_PUSH_STATE.backend='unknown';roggyPushRender();return}
  try{
    const registration=await roggyPushEnsureRegistration();ROGGY_PUSH_STATE.subscription=await registration.pushManager.getSubscription();
    if(ROGGY_PUSH_STATE.subscription&&!roggyPushSubscriptionIsValid(ROGGY_PUSH_STATE.subscription)){await ROGGY_PUSH_STATE.subscription.unsubscribe().catch(()=>{});ROGGY_PUSH_STATE.subscription=null;ROGGY_PUSH_STATE.failureStage='subscription'}
    ROGGY_PUSH_STATE.backendRegistration=ROGGY_PUSH_STATE.subscription&&ROGGY_PUSH_STATE.session?'checking':'missing';
    if(ROGGY_PUSH_STATE.session){
      const diagnostics=await roggyPushInvoke({action:'diagnostics',endpoint:ROGGY_PUSH_STATE.subscription?.endpoint});ROGGY_PUSH_STATE.backendRegistration=diagnostics.registration?.status||'missing';ROGGY_PUSH_STATE.backend=diagnostics.push_backend?.status||'unknown';
      if(ROGGY_PUSH_STATE.subscription&&diagnostics.registration?.status==='disabled')await roggyPushSyncSubscription(ROGGY_PUSH_STATE.subscription);
    }
    if(ROGGY_PUSH_STATE.subscription&&ROGGY_PUSH_STATE.session&&ROGGY_PUSH_STATE.backendRegistration!=='active'){await roggyPushSyncSubscription(ROGGY_PUSH_STATE.subscription);ROGGY_PUSH_STATE.backendRegistration='active'}
  }catch(error){
    const failure=roggyPushFormatError(error);ROGGY_PUSH_STATE.failureStage=failure.stage;ROGGY_PUSH_STATE.lastError={code:failure.code,message:error?.message||failure.message,detail:failure.detail};if(error?.code==='PUSH_CONFIGURATION_MISSING'||error?.code==='PUSH_CONFIGURATION_INVALID')ROGGY_PUSH_STATE.backend='error';else if(ROGGY_PUSH_STATE.serviceWorker!=='active')ROGGY_PUSH_STATE.serviceWorker='error';else ROGGY_PUSH_STATE.backendRegistration='error';roggyPushSetStatus(failure.message,failure.note);
  }
  roggyPushRender();
}
async function roggyPushEnable(){
  if(ROGGY_PUSH_STATE.busy)return;ROGGY_PUSH_STATE.busy=true;
  try{
    ROGGY_PUSH_STATE.support=roggyPushSupport();if(!ROGGY_PUSH_STATE.support.ok){roggyPushRender();return}ROGGY_PUSH_STATE.session=await roggyPushSession();if(!ROGGY_PUSH_STATE.session){roggyPushRender();return}
    const permission=await Notification.requestPermission();ROGGY_PUSH_STATE.permission=permission;if(permission!=='granted'){ROGGY_PUSH_STATE.failureStage='permission';roggyPushRender();return}
    const registration=await roggyPushEnsureRegistration();const existing=await registration.pushManager.getSubscription();ROGGY_PUSH_STATE.subscription=existing&&roggyPushSubscriptionIsValid(existing)?existing:await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:roggyPushBase64ToBytes(ROGGY_PUSH_PUBLIC_KEY)});
    await roggyPushSyncSubscription(ROGGY_PUSH_STATE.subscription);const diagnostics=await roggyPushInvoke({action:'diagnostics',endpoint:ROGGY_PUSH_STATE.subscription.endpoint});ROGGY_PUSH_STATE.backendRegistration=diagnostics.registration?.status||'missing';ROGGY_PUSH_STATE.backend=diagnostics.push_backend?.status||'unknown';ROGGY_PUSH_STATE.failureStage=null;
  }catch(error){const failure=roggyPushFormatError(error);ROGGY_PUSH_STATE.failureStage=failure.stage;ROGGY_PUSH_STATE.lastError={code:failure.code,message:error?.message||failure.message,detail:failure.detail};ROGGY_PUSH_STATE.subscription=null;roggyPushSetStatus(failure.message,failure.note)}
  finally{ROGGY_PUSH_STATE.busy=false}roggyPushRender();
}
async function roggyPushDisable(){
  if(ROGGY_PUSH_STATE.busy||!ROGGY_PUSH_STATE.subscription)return;ROGGY_PUSH_STATE.busy=true;
  try{ROGGY_PUSH_STATE.session=await roggyPushSession();if(ROGGY_PUSH_STATE.session)await roggyPushInvoke({action:'unsubscribe',endpoint:ROGGY_PUSH_STATE.subscription.endpoint});await ROGGY_PUSH_STATE.subscription.unsubscribe();ROGGY_PUSH_STATE.subscription=null;ROGGY_PUSH_STATE.backendRegistration='missing';ROGGY_PUSH_STATE.backend='healthy'}
  catch(error){const failure=roggyPushFormatError(error);ROGGY_PUSH_STATE.failureStage=failure.stage;ROGGY_PUSH_STATE.lastError={code:failure.code,message:error?.message||failure.message,detail:failure.detail};roggyPushSetStatus(failure.message,failure.note);return}
  finally{ROGGY_PUSH_STATE.busy=false}roggyPushRender();
}
async function roggyPushTest(){
  if(ROGGY_PUSH_STATE.busy)return;ROGGY_PUSH_STATE.busy=true;ROGGY_PUSH_STATE.lastAttempt=new Date().toISOString();ROGGY_PUSH_STATE.lastResult='not_run';ROGGY_PUSH_STATE.lastError=null;ROGGY_PUSH_STATE.failureStage=null;roggyPushWriteHistory();roggyPushRenderDiagnostics();
  try{
    if(!ROGGY_PUSH_STATE.subscription)throw roggyPushErrorFromResponse('NO_ACTIVE_SUBSCRIPTION','No active subscription is registered for this device.');
    const result=await roggyPushInvoke({action:'send_test',endpoint:ROGGY_PUSH_STATE.subscription.endpoint});ROGGY_PUSH_STATE.lastResult='success';ROGGY_PUSH_STATE.backend='healthy';ROGGY_PUSH_STATE.backendRegistration='active';ROGGY_PUSH_STATE.failureStage=null;roggyPushWriteHistory();roggyPushSetStatus('Test notification accepted by the push provider.','Delivery to the device is not confirmed by Web Push; check the device notification tray.');return result;
  }catch(error){const failure=roggyPushFormatError(error);ROGGY_PUSH_STATE.lastResult='failure';ROGGY_PUSH_STATE.failureStage=failure.stage;ROGGY_PUSH_STATE.lastError={code:failure.code,message:error?.message||failure.message,detail:failure.detail};if(failure.code==='PUSH_SUBSCRIPTION_EXPIRED')ROGGY_PUSH_STATE.subscription=null;if(failure.code==='PUSH_CONFIGURATION_MISSING'||failure.code==='PUSH_CONFIGURATION_INVALID')ROGGY_PUSH_STATE.backend='error';roggyPushWriteHistory();roggyPushSetStatus(failure.message,failure.note);return null}
  finally{ROGGY_PUSH_STATE.busy=false;roggyPushRender()}
}
function roggyPushInit(){
  roggyPushReadHistory();roggyPushElement('pushEnable')?.addEventListener('click',roggyPushEnable);roggyPushElement('pushDisable')?.addEventListener('click',roggyPushDisable);roggyPushElement('pushTest')?.addEventListener('click',roggyPushTest);window.addEventListener('roggy-auth',()=>roggyPushRefresh().catch(()=>{}));roggyPushRefresh().catch(error=>{ROGGY_PUSH_STATE.failureStage='frontend';ROGGY_PUSH_STATE.lastError={code:error?.name||'PUSH_REFRESH_FAILED',message:error?.message||'Refresh failed'};roggyPushRender()});
}
window.roggyPush={refresh:roggyPushRefresh,enable:roggyPushEnable,disable:roggyPushDisable,test:roggyPushTest};
roggyPushInit();
