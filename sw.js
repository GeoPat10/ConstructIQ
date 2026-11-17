importScripts('assets/js/push-shared.js','assets/pdf-assets.js');
/* Cache only the development app shell. Never cache auth, APIs or remote files. */
const CACHE='constructiq-connected-shell-b006c842d6d8';
const SHELL=['./','index.html','manifest.webmanifest','icon-192.png','apple-touch-icon.png','config/development.js','assets/css/app.css','assets/css/theme.css','assets/js/data.js','assets/js/app.js','assets/js/auth.js','assets/js/enhancements.js','assets/js/push-shared.js','assets/js/notifications.js','assets/js/pdf-viewer.js','assets/js/offline.js','assets/js/sync-adapter.js','assets/pdf-assets.js',...(typeof CI_PDF_ASSETS==='undefined'?[]:CI_PDF_ASSETS)];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(async cache=>{await cache.addAll(SHELL);await cache.put(new URL('__offline_ready__',self.registration.scope).href,new Response('ready'));}));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>(key.startsWith('constructiq-development-shell-')||key.startsWith('constructiq-connected-shell-'))&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 if(event.request.method!=='GET')return;
 const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;
 const base=new URL('./',self.location.href);const allowed=new Set(SHELL.map(path=>new URL(path,base).href));
 if(!allowed.has(url.href))return;
 event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));}return response;}).catch(async()=>{const cached=await caches.match(event.request);return cached||new Response('Development app unavailable offline. Open it online once first.',{status:503});}));
});

self.addEventListener('push',event=>{
 let payload={};try{payload=event.data?.json()||{};}catch(e){}
 const message=CIPushShared.notification(payload,self.registration.scope);
 event.waitUntil(self.registration.showNotification(message.title,message.options));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 // Reconstruct from a same-scope URL; never trust a remote URL in a payload.
 let candidate;try{candidate=new URL(event.notification.data?.url);}catch(e){candidate=new URL(self.registration.scope);}
 const scope=new URL(self.registration.scope);const destination=candidate.origin===scope.origin&&candidate.pathname===scope.pathname?candidate.href:scope.href;
 event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{
  const existing=windows.find(client=>client.url.startsWith(scope.href));
  if(existing){const navigated=await existing.navigate(destination);return navigated?.focus();}
  return self.clients.openWindow(destination);
 }));
});

self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();});
