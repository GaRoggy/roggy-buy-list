const CACHE='roggy-lists-v40';
const ASSETS=['./','index.html','styles.css?v=40','app.js?v=40','monitor-ui.js?v=40','manifest.json','icon.svg'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('roggy-lists-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin||!ASSETS.some(a=>new URL(a,self.registration.scope).href===url.href))return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});
