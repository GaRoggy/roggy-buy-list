const CACHE='roggy-lists-v82';
const ASSETS=['./','index.html','styles.css?v=122','todos.css?v=61','polish.css?v=109','network.css?v=1','pc-health.css?v=2','app.js?v=125','push-notifications.js?v=3','monitor-ui.js?v=53','todos.js?v=65','polish.js?v=109','network.js?v=1','network-model.mjs','pc-health.js?v=4','manifest.json','icon.svg?v=2','assets/mountain-panorama.jpg','ai-config.js?v=45','ai-ui.js?v=45','transcript.js?v=4','ai/browser/provider.js','ai/shared/protocol.js'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('roggy-lists-')&&k!==CACHE).map(k=>caches.delete(k)))),
  self.clients.claim()
])));
function safeAppUrl(value){
  const base=new URL('./',self.registration.scope);
  try{
    const candidate=new URL(typeof value==='string'&&value?value:'./',base);
    if(candidate.origin!==self.location.origin||!candidate.pathname.startsWith(base.pathname))return null;
    return candidate.href;
  }catch{return null}
}
self.addEventListener('push',e=>{
  let data={};
  try{data=e.data?.json()||{}}catch{try{data=JSON.parse(e.data?.text()||'{}')}catch{data={}}}
  const title=typeof data.title==='string'&&data.title.trim()?data.title.trim():'Roggy Lists';
  const body=typeof data.body==='string'&&data.body.trim()?data.body.trim():'You have an update.';
  const base=new URL('./',self.registration.scope);
  const target=safeAppUrl(data.url)||base.href;
  const icon=new URL('icon.svg?v=2',base).href;
  const options={body,icon:safeAppUrl(data.icon)||icon,badge:icon,tag:typeof data.tag==='string'&&data.tag.trim()?data.tag.trim():'roggy-lists',data:{url:target}};
  e.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const target=safeAppUrl(e.notification?.data?.url)||new URL('./',self.registration.scope).href;
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{
    const existing=windows.find(client=>client.url.startsWith(new URL('./',self.registration.scope).href));
    if(existing){await existing.focus();if(existing.url!==target&&'navigate' in existing)await existing.navigate(target);return}
    return clients.openWindow(target);
  }));
});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin||!ASSETS.some(a=>new URL(a,self.registration.scope).href===url.href))return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).catch(()=>caches.match(e.request)));
});
