/* Development-only additions; no shared audit or notification claims. */
function showWorkspaceInfo(){if(CI_CONFIG.cloudEnabled){alert('ConstructIQ 2.0\n\nShared projects use your existing database. Saved changes wait on this device when offline. Use Sync to review conflicts and Offline files before leaving site. Signing out turns off this device’s alerts.');return;}alert('ConstructIQ 2.0 development\n\nTest projects and files are saved on this device. Live Supabase access is disabled. Export backups regularly.\n\nShared accounts, protected activity history and push notifications require the separate test backend.');}
async function renderActivity(){
 const target=document.getElementById('activityItems');if(!target)return;
 const project=current();let entries=project?.activity||[];
 if(CI_CONFIG.cloudEnabled&&project?.cloudId&&navigator.onLine){try{const shared=await api('/rest/v1/rpc/ci_project_activity',{method:'POST',body:JSON.stringify({p_project_id:project.cloudId})});if(current()?.id!==project.id)return;entries=[...shared,...entries.map(e=>({...e,summary:e.summary+' (device record)'}))];}catch{/* Keep local history available offline. */}}
 target.innerHTML=entries.length?entries.slice().reverse().map(e=>`<div class="activityItem"><div class="title">${esc(e.summary)}</div><div class="muted">${esc(e.actor)} · ${esc(new Date(e.at).toLocaleString('en-GB'))}</div></div>`).join(''):'<div class="empty">New changes will appear here.</div>';
}
function editDocumentDetails(id){
 const file=current()?.files.find(f=>f.id===id);if(!file)return;
 const dialog=document.getElementById('documentDialog');dialog.dataset.fileId=id;
 document.getElementById('editFolder').value=file.folder||'General';
 document.getElementById('editNumber').value=file.drawingNumber||'';
 document.getElementById('editRevision').value=file.revision||'';
 dialog.showModal();
}
async function saveDocumentDetails(event){
 event.preventDefault();const dialog=document.getElementById('documentDialog');const file=current()?.files.find(f=>f.id===dialog.dataset.fileId);if(!file)return;
 const number=document.getElementById('editNumber').value.trim();const revision=document.getElementById('editRevision').value.trim();
 if(number&&!revision){document.getElementById('editRevision').setCustomValidity('Enter the drawing revision');document.getElementById('editRevision').reportValidity();return;}
 if(number&&current().files.some(f=>f.id!==file.id&&f.drawingNumber===number&&f.revision===revision)){alert('This drawing number and revision already exist. Use a new revision code.');return;}
 Object.assign(file,{folder:document.getElementById('editFolder').value.trim()||'General',drawingNumber:number,revision:number?revision:''});
 await persist();dialog.close();renderPlanFiles();
}
const dialog=document.createElement('dialog');dialog.id='documentDialog';dialog.className='dialog';
dialog.innerHTML='<form onsubmit="saveDocumentDetails(event)"><h2>Document details</h2><p class="muted">Keep drawing versions as separate uploads. For the same drawing number, the most recently uploaded file is marked current.</p><label for="editFolder">Folder</label><input id="editFolder" maxlength="100"><div class="grid"><div><label for="editNumber">Drawing number (optional)</label><input id="editNumber" maxlength="100"></div><div><label for="editRevision">Revision</label><input id="editRevision" maxlength="30" oninput="this.setCustomValidity(\'\')"></div></div><div class="actions"><button class="primary" type="submit">Save details</button><button class="secondary" type="button" onclick="document.getElementById(\'documentDialog\').close()">Cancel</button></div></form>';
document.body.appendChild(dialog);
// Dictation starts only on an explicit click. Review text before applying it.
const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
const voiceBox=document.createElement('div');voiceBox.className='voiceTools noPrint';
voiceBox.innerHTML='<button type="button" class="secondary small" id="voiceStart">Dictate notes</button><span class="voiceStatus" id="voiceStatus"></span>';
document.getElementById('pNotes').after(voiceBox);
const voiceButton=document.getElementById('voiceStart');const voiceStatus=document.getElementById('voiceStatus');
if(!Recognition){voiceButton.disabled=true;voiceStatus.textContent='Dictation is unavailable in this browser. You can type notes as usual.';}
else voiceButton.addEventListener('click',()=>{
 if(!confirm('Start microphone dictation? Your browser may use its speech service to process audio. You can review the text before adding it to your notes.'))return;
 const projectId=currentId;const recognizer=new Recognition();recognizer.lang='en-GB';recognizer.interimResults=false;voiceButton.disabled=true;voiceStatus.textContent='Listening…';
 recognizer.onresult=e=>{const words=e.results[0][0].transcript;if(projectId!==currentId)return;if(confirm('Add this text to your notes?\n\n'+words)){const notes=document.getElementById('pNotes');notes.value+=(notes.value?'\n':'')+words;voiceStatus.textContent='Added. Review and select Save details.';}};
 recognizer.onerror=e=>{voiceStatus.textContent='Dictation stopped: '+e.error+'. You can type instead.';};recognizer.onend=()=>{voiceButton.disabled=false;if(voiceStatus.textContent==='Listening…')voiceStatus.textContent='Stopped.';};
 try{recognizer.start();}catch(e){voiceButton.disabled=false;voiceStatus.textContent='Could not start dictation. You can type instead.';}
});
// Associate existing labels with their fields without changing their visible copy.
for(const label of document.querySelectorAll('label:not([for])')){const field=label.parentElement.querySelector('input,textarea,select');if(field?.id)label.htmlFor=field.id;}
window.addEventListener('unhandledrejection',e=>{console.error(e.reason);toast('Could not complete that action. Your last saved data is kept. Please export a backup and retry.',true);});

async function showOfflineStatus(){if(!current())return;const result=await offlineEngine.downloadFiles(current(),CIData.references);const ready=await caches.match(new URL('__offline_ready__',document.baseURI).href);const queue=await offlineEngine.list();alert('Offline files for this project: '+result.saved+' available, '+result.missing+' missing.\n\n'+(result.missing?'Connect and download missing files before leaving site.':ready?'The offline app and PDF renderer are downloaded. Saved files are available without internet.':'The offline app is still installing. Keep it open online, apply any app update, then check again before leaving site.')+'\n\n'+(offlineEngine.adapter?queue.length+' changes awaiting sync.':'This preview stores test data on this device. Live cloud syncing is disconnected.'));}
window.addEventListener('offline',()=>setSync('Offline · saved on device','ok'));
window.addEventListener('online',()=>{setSync('On this device','ok');offlineEngine?.flush();});

if('serviceWorker' in navigator){
 let requestedUpdate=false;
 const updateButton=document.createElement('button');updateButton.className='headBtn small';updateButton.textContent='Update app';updateButton.hidden=true;document.querySelector('header .actions').appendChild(updateButton);
 navigator.serviceWorker.ready.then(registration=>{const show=()=>{updateButton.hidden=!registration.waiting;};show();registration.addEventListener('updatefound',()=>{registration.installing?.addEventListener('statechange',show);});updateButton.onclick=()=>{if(!registration.waiting)return;if(!confirm('Reload to apply the downloaded app update? Save any open form first.'))return;requestedUpdate=true;registration.waiting.postMessage({type:'ACTIVATE_UPDATE'});};});
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(requestedUpdate)location.reload();});
}

if(CI_CONFIG.cloudEnabled){for(const [text,action] of [['Refresh projects',refreshProjects],['Sync',reviewSync]]){const button=document.createElement('button');button.className='headBtn small';button.textContent=text;button.onclick=action;document.querySelector('header .actions').appendChild(button);}}
