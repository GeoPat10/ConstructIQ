/* Device subscription controls. Disabled until the reviewed backend is deployed. */
(function(){
 const config=CI_CONFIG.push||{};const categoryKeys=Object.keys(CIPushShared.categories).filter(key=>key!=='test');const btn=document.createElement('button');btn.className='headBtn small';btn.type='button';btn.textContent='Notifications';btn.id='notificationsButton';document.querySelector('header .actions').prepend(btn);
 const modal=document.createElement('dialog');modal.id='notificationsDialog';modal.className='dialog';
 modal.innerHTML='<h2>Notifications</h2><p class="muted">Get alerts on your phone while ConstructIQ is closed. Notifications show a general message; open the app to see project details.</p><p id="pushSetup" class="notice"></p><p id="pushStatus" class="muted" role="status" aria-live="polite"></p><fieldset class="notificationOptions"><legend>Notify me about</legend>'+Object.entries(CIPushShared.categories).filter(([key])=>key!=='test').map(([key,item])=>'<label class="notificationOption"><input type="checkbox" id="notify-'+key+'" checked> '+item.label+'</label>').join('')+'</fieldset><div class="actions"><button id="pushEnable" class="primary" type="button">Enable on this device</button><button id="pushTest" class="secondary" type="button">Send test alert</button><button id="pushDisable" class="secondary" type="button">Turn off on this device</button><button id="pushClose" class="secondary" type="button">Close</button></div>';
 document.body.appendChild(modal);const find=id=>document.getElementById(id);const status=text=>{find('pushStatus').textContent=text;};
 const supported=()=>window.isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 const ios=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 const token=()=>typeof accessToken==='string'?accessToken:null;
 function configured(){return CI_CONFIG.cloudEnabled===true&&config.enabled===true&&/^https:\/\//.test(config.apiUrl||'')&&config.publicKey&&config.publishableKey;}
 function prefs(){return Object.fromEntries(categoryKeys.map(key=>[key,find('notify-'+key).checked]));}
 async function call(action,body){
  if(typeof account!=='undefined'&&account)accessToken=await account.token();
  if(!configured()||!token())throw new Error('Sign in to the connected workspace before enabling notifications.');
  const response=await fetch(config.apiUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token(),apikey:config.publishableKey},body:JSON.stringify({action,...body})});
  if(!response.ok)throw new Error(response.status===401?'Your session has expired. Sign in again.':'Could not update notification settings. Please retry.');return response.json();
 }
 function publicKeyBytes(key){const raw=atob(key.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-key.length%4)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
 async function ready(){const registration=await navigator.serviceWorker.getRegistration();if(!registration?.active)throw new Error('The app is still installing. Close and reopen it, then retry.');return registration;}
 async function render(){
  find('pushSetup').textContent=!configured()?'Background alerts are being set up. They are not active in this development build.':ios()&&!standalone()?'On iPhone: use Share → Add to Home Screen, open ConstructIQ from its icon, then enable notifications here.':'Enable once on each device. Closing the app keeps alerts on; signing out turns them off on this device.';
  const enabled=configured()&&supported()&&(!ios()||standalone())&&!!token();find('pushEnable').disabled=!enabled;find('pushEnable').textContent='Enable on this device';modal.querySelector('fieldset').disabled=!enabled;find('pushTest').disabled=true;find('pushDisable').disabled=true;
  if(!supported()){status('This browser does not support background notifications here.');return;}
  const registration=await navigator.serviceWorker.getRegistration();const sub=await registration?.pushManager?.getSubscription();
  find('pushDisable').disabled=!sub;find('pushTest').disabled=!enabled||!sub;
  if(!configured())status('Not active yet. Your live notification settings have not changed.');
  else if(Notification.permission==='denied')status('Notifications are blocked. Allow them in your device or browser settings.');
  else if(sub&&enabled){const server=await call('status',{endpoint:sub.endpoint});for(const key of categoryKeys)find('notify-'+key).checked=server.preferences?.[key]===true;find('pushTest').disabled=!server.enabled;find('pushEnable').textContent=server.enabled?'Save preferences':'Enable on this device';status(server.enabled?'This device is registered. Use Send test alert to check delivery.':'Alerts are disabled on the server. Select Enable on this device to reconnect.');}
  else status('Notifications are off on this device.');
 }
 btn.addEventListener('click',()=>{modal.showModal();render().catch(()=>status('Could not read this device’s settings.'));});find('pushClose').onclick=()=>modal.close();
 find('pushEnable').onclick=async()=>{
  if(!configured()||!token()||!supported())return;
  // Ask immediately following the tap, before awaiting any background work (required on iOS).
  const permission=Notification.permission==='default'?Notification.requestPermission():Promise.resolve(Notification.permission);
  try{
   find('pushEnable').disabled=true;if(await permission!=='granted')throw new Error('Notifications were not allowed. You can enable them later.');
   const registration=await ready();let subscription=await registration.pushManager.getSubscription();let created=false;
   if(!subscription){subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:publicKeyBytes(config.publicKey)});created=true;}
   try{await call('register',{subscription:subscription.toJSON(),preferences:prefs()});}catch(e){if(created)await subscription.unsubscribe();throw e;}
   await render();status('Notifications enabled. Send a test alert, then close the app to check background delivery.');
  }catch(e){status(e.message);find('pushEnable').disabled=false;}
 };
 async function disable(){
  if(!('serviceWorker' in navigator))return;
  const registration=await navigator.serviceWorker.getRegistration();const subscription=await registration?.pushManager?.getSubscription();if(!subscription)return;
  const endpoint=subscription.endpoint;
  // Unsubscribe locally first so losing the network cannot leave this device receiving alerts.
  const removed=await subscription.unsubscribe();if(!removed)throw new Error('Could not turn off this device’s subscription. Retry before signing out.');
  let cleanupPending=false;try{await call('remove',{endpoint});}catch(e){cleanupPending=true;}
  return {cleanupPending};
 }
 find('pushDisable').onclick=async()=>{try{const result=await disable();await render();status(result?.cleanupPending?'Alerts are off on this device. Server cleanup will finish when the expired subscription is detected.':'Alerts are off on this device.');}catch(e){status(e.message);}};
 find('pushTest').onclick=async()=>{try{const subscription=await (await ready()).pushManager.getSubscription();if(!subscription)throw new Error('Enable notifications first.');await call('test',{endpoint:subscription.endpoint});status('Test accepted by the push service. Check your phone’s notifications to confirm delivery.');}catch(e){status(e.message);}};
 window.CINotifications={beforeSignOut:disable};
 async function openNotification(){
  if(!location.hash.startsWith('#project='))return;const route=new URLSearchParams(location.hash.slice(1));
  const p=projects.find(p=>p.id===route.get('project')||String(p.cloudId||'')===route.get('project'));if(!p)return;
  const section=route.get('section');if(!['overview','checklist','materials','bc','hs','report','urgent','diary','issues'].includes(section))return;
  await selectProject(p.id);const tab=[...document.querySelectorAll('.tab')].find(t=>(t.getAttribute('onclick')||'').includes("showTab('"+section+"'"));showTab(section,tab);
 }
 window.addEventListener('hashchange',()=>openNotification().catch(console.error));window.addEventListener('ci:ready',()=>openNotification().catch(console.error));
 if(projects.length)openNotification().catch(console.error);
})();
