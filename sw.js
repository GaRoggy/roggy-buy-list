const CACHE='roggy-lists-v64';
const ASSETS=['./','index.html','styles.css?v=110','todos.css?v=61','polish.css?v=109','app.js?v=98','monitor-ui.js?v=53','todos.js?v=65','polish.js?v=109','manifest.json','icon.svg?v=2','assets/mountain-panorama.jpg','ai-config.js?v=43','ai-ui.js?v=42','transcript.js','ai/browser/provider.js','ai/shared/protocol.js'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('roggy-lists-')&&k!==CACHE).map(k=>caches.delete(k)))),
  self.clients.claim()
])));
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin||!ASSETS.some(a=>new URL(a,self.registration.scope).href===url.href))return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).catch(()=>caches.match(e.request)));
});
