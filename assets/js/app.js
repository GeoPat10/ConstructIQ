const SUPABASE_URL=CI_CONFIG.url||'';
const SUPABASE_KEY=CI_CONFIG.publishableKey||'';
let accessToken=null, currentUserId=null, cloudReady=false, syncing=false;
let DB_NAME=CI_CONFIG.databaseName;const DB_VER=3;
const account=CI_CONFIG.cloudEnabled?CIAuth.create({url:SUPABASE_URL,key:SUPABASE_KEY,storageKey:'CI2_SESSION'}):null;
let syncTimer=null,cloudAdapter=null,canRemoveRecords=!CI_CONFIG.cloudEnabled;
if(CI_CONFIG.cloudEnabled)document.body.classList.add('no-removals');
function requireRemovalPermission(){if(canRemoveRecords)return true;toast('Only George, the owner, can remove records or files.');return false;}
const selectionKey=()=>CI_CONFIG.cloudEnabled?'CI2_CURRENT_'+currentUserId:'CI2_DEV_CURRENT';
const STAGES=[
'Pre-start / site setup','Groundworks','Brickwork to oversite','Brickwork and blockwork','Steel works / structural works','Roofing','Rendering / cladding','1st fix carpentry','1st fix plumbing / heating','1st fix electrical','Insulation / plasterboard','Plastering / finishes','2nd fix plumbing','2nd fix electrics','2nd fix carpentry','Kitchen','Bathroom','Decoration','Flooring','Landscaping','Snagging / final inspection','Handover'
];
const BC_STAGES=[
'Commencement','Excavation / foundations','Concrete / foundation pour','Oversite / DPC','Drainage (before backfill)','Drainage test','Structural steel / lintels','Roof structure','Insulation (floor / walls / roof)','Fire stopping / cavity barriers','Pre-plaster','Completion','Other'
];
const PHOTO_MAX=2000, PHOTO_Q=0.82, THUMB_MAX=480, THUMB_Q=0.75;
let offlineEngine=null;
let db, projects=[], currentId=null, filterMode='all', deferredPrompt=null, bcPendingStage=null;
const thumbUrls=new Map();

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function today(){return new Date().toISOString().slice(0,10)}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VER);r.onupgradeneeded=()=>{const d=r.result;for(const name of ['outbox','uploads'])if(!d.objectStoreNames.contains(name))d.createObjectStore(name,{keyPath:'id'});if(!d.objectStoreNames.contains('syncState'))d.createObjectStore('syncState',{keyPath:'projectId'});if(!d.objectStoreNames.contains('projects'))d.createObjectStore('projects',{keyPath:'id'});if(!d.objectStoreNames.contains('photos'))d.createObjectStore('photos',{keyPath:'id'});if(!d.objectStoreNames.contains('planFiles'))d.createObjectStore('planFiles',{keyPath:'id'});if(!d.objectStoreNames.contains('changeFiles'))d.createObjectStore('changeFiles',{keyPath:'id'})};r.onsuccess=()=>{db=r.result;resolve()};r.onerror=()=>reject(r.error)})}
function tx(store,mode='readonly'){return db.transaction(store,mode).objectStore(store)}
function getAll(store){return new Promise((res,rej)=>{const r=tx(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function put(store,obj){return new Promise((res,rej)=>{const transaction=db.transaction(store,'readwrite');transaction.objectStore(store).put(obj);transaction.oncomplete=()=>res();transaction.onerror=()=>rej(transaction.error);transaction.onabort=()=>rej(transaction.error||new Error('Save cancelled'));})}

function del(store,id){return new Promise((res,rej)=>{const transaction=db.transaction(store,'readwrite');transaction.objectStore(store).delete(id);transaction.oncomplete=()=>res();transaction.onerror=()=>rej(transaction.error);transaction.onabort=()=>rej(transaction.error||new Error('Delete cancelled'));})}

function get(store,id){return new Promise((res,rej)=>{const r=tx(store).get(id);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}

function blankProject(name='New project'){
 return {id:uid(),name,manager:'',address:'',ref:'',start:today(),target:'',notes:'',created:Date.now(),
 checklist:STAGES.map(s=>({id:uid(),title:s,status:'red',date:'',notes:''})),
 materials:[],diary:[],issues:[],files:[],bcPhotos:[],hsFiles:[],ppe:defaultPPE(),ppeV:2,urgent:[]};
}
const OLD_TYPE_MAP={Issue:'Site instruction',Progress:'Other',Visit:'Other',Delivery:'Other',General:'Other'};
function migrateProject(p){
 let changed=false;
 for(const x of p.checklist||[]){if(!x.status){x.status=x.done?'green':'red';changed=true}}
 if(!p.files){p.files=[];changed=true}
 if(!p.bcPhotos){p.bcPhotos=[];changed=true}
 if(!p.hsFiles){p.hsFiles=[];changed=true}
 if(!p.urgent){p.urgent=[];changed=true}
 if(!p.ppe){p.ppe=defaultPPE();p.ppeV=2;changed=true}
 if(!p.ppeV){if(!p.ppe.some(x=>/dust suit/i.test(x.item))){const i=p.ppe.findIndex(x=>/mask/i.test(x.item));p.ppe.splice(i<0?p.ppe.length:i+1,0,{id:uid(),item:'Full dust suits',status:'green',reportedBy:'',reportedDate:'',notes:'',replacedDate:''})}p.ppeV=2;changed=true}
 // Older materials had Required/Ordered/On site/Used. On site or Used = delivered (green); everything else = not delivered (red).
 for(const m of p.materials||[]){
   if(!m.id){m.id=uid();changed=true}
   if(m.delivered===undefined){m.delivered=m.status==='On site'||m.status==='Used';m.deliveredDate='';if(m.stageId===undefined)m.stageId='';changed=true}
 }
 for(const d of p.diary||[]){
   if(!d.files){d.files=[];changed=true}
   if(d.type && OLD_TYPE_MAP[d.type]){d.type=OLD_TYPE_MAP[d.type];changed=true}
 }
 return changed;
}
async function api(path,options={}){
 if(!CI_CONFIG.cloudEnabled)throw new Error('Cloud access is disabled in this development build.');
 const token=await account.token();if(!token)throw Object.assign(new Error('Sign in required'),{status:401});accessToken=token;
 const response=await fetch(SUPABASE_URL+path,{...options,headers:{apikey:SUPABASE_KEY,Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Object.assign(new Error(response.status===401?'Sign in again to reconnect.':'Cloud request failed; device changes are preserved.'),{status:response.status});return response.status===204?null:response.json();
}

function setSync(text,state=''){const e=document.getElementById('syncState');if(!e)return;e.textContent=text;e.className='syncPill '+state}
function storagePath(projectId,fileId,name){
 const safe=String(name||'file').replace(/[^a-z0-9._-]+/gi,'_').slice(0,100)||'file';
 return `${currentUserId||'user'}/${projectId||'project'}/${fileId}-${safe}`;
}
function encPath(path){return String(path).split('/').map(encodeURIComponent).join('/')}
async function uploadCloudFile(path,blob,mime){if(offlineEngine)await offlineEngine.stageUpload(path,blob,mime);return null;}

async function signedCloudUrl(path){if(!CI_CONFIG.cloudEnabled)throw new Error('Cloud files are disconnected in development.');const result=await api('/storage/v1/object/sign/project-files/'+encPath(path),{method:'POST',body:JSON.stringify({expiresIn:120})});return SUPABASE_URL+'/storage/v1'+result.signedURL;}

async function cloudBlob(path){if(!cloudAdapter)throw new Error('This attachment is not downloaded. Import a complete backup into this workspace.');return cloudAdapter.download(path);}

function cloudFilePathForId(id){
 const p=current();if(!p)return null;
 for(const x of p.bcPhotos||[])if(x.id===id&&x.path)return x.path;
 for(const i of p.issues||[])for(const x of i.photos||[])if(x.id===id&&x.path)return x.path;
 for(const u of p.urgent||[])for(const x of u.photos||[])if(x.id===id&&x.path)return x.path;
 for(const x of p.files||[])if(x.id===id&&x.path)return x.path;
 for(const x of p.hsFiles||[])if(x.id===id&&x.path)return x.path;
 for(const d of p.diary||[])for(const x of d.files||[])if(x.id===id&&x.path)return x.path;
 return null;
}
async function getPhotoRecord(id){
 let rec=await get('photos',id);
 if(rec?.blob)return rec;
 const path=cloudFilePathForId(id);if(!path)return rec||null;
 try{const blob=await cloudBlob(path);rec={id,name:rec?.name||id,type:blob.type||rec?.type||'image/jpeg',blob};await put('photos',rec);return rec}catch(e){console.error(e);return null}
}

async function signIn(){authErr.textContent='';try{if(!account)throw new Error('Cloud access is disabled.');const session=await account.signIn(loginEmail.value.trim(),loginPassword.value);loginPassword.value='';accessToken=session.access_token;currentUserId=session.user.id;await startCloud();}catch(e){authErr.textContent=e.status===400||e.status===401?'Could not sign in. Check your email and password.':e.message;}}
async function signOut(){if(window.CINotifications)await window.CINotifications.beforeSignOut();clearInterval(syncTimer);if(account)await account.signOut();accessToken=null;currentUserId=null;if(db)db.close();location.reload();}
async function restoreSession(){if(!account)return false;const session=await account.restore();if(!session)return false;accessToken=session.access_token;currentUserId=session.user.id;return true;}
function rowToProject(r){try{const d=JSON.parse(r.notes||'');if(d&&typeof d==='object'){d.cloudId=r.id;d.name=r.name||d.name;d.address=r.address||d.address;return migrateProject(d),d}}catch(e){}const p=blankProject(r.name||'Untitled project');p.cloudId=r.id;p.address=r.address||'';p.start=r.start_date||today();p.target=r.completion_date||'';p.notes=r.notes||'';return p}
function projectRow(p){const copy=JSON.parse(JSON.stringify(p));return {name:p.name||'Untitled project',client_name:'',address:p.address||'',status:'Active',start_date:p.start||null,completion_date:p.target||null,notes:JSON.stringify(copy)}}
async function pullCloud(){
 const rows=await api('/rest/v1/rpc/ci_list_projects',{method:'POST',body:'{}'});
 for(const row of rows)await offlineEngine.applyRemote(rowToProject(row),row);
 const allowed=new Set(rows.map(row=>String(row.id)));const pending=await offlineEngine.list();
 for(const local of await getAll('projects')){const base=await offlineEngine.read('syncState',local.id);const cloudId=local.cloudId||base?.base?.id;if(cloudId&&!allowed.has(String(cloudId))){if(pending.some(x=>x.projectId===local.id))setSync('Project access changed · local edits preserved','bad');else await del('projects',local.id);}}
 const local=await getAll('projects');projects=[];for(const p of local){const state=await offlineEngine.read('syncState',p.id);const remoteId=p.cloudId||state?.base?.id;if(!p._archived&&(!remoteId||allowed.has(String(remoteId))))projects.push(p);}return projects;
}
async function pushProject(p){if(!CI_CONFIG.cloudEnabled)throw new Error('Cloud writes are disabled in this development build.');await offlineEngine.save(p);return offlineEngine.flush();}
function syncStatus(state){const labels={local:navigator.onLine?'Saved on device':'Offline · saved on device',pending:'Saved · awaiting sync',syncing:'Syncing…',synced:'Synced',conflict:'Conflicting edits · review Sync',session:'Sign in to reconnect',retry:'Saved · retrying connection',permissions:'Change blocked · shared records preserved'};setSync(labels[state]||state,['conflict','session','retry'].includes(state)?'bad':'ok');}
async function startCloud(){
 if(!currentUserId)throw new Error('Sign in required');
 const permissionKey='CI2_APP_VERIFIED_'+currentUserId;
 if(navigator.onLine){const allowed=await api('/rest/v1/rpc/ci_account_access',{method:'POST',body:'{}'});if(!allowed){localStorage.removeItem(permissionKey);throw new Error('This account has not been given ConstructIQ access. Ask George to add it.');}localStorage.setItem(permissionKey,String(Date.now()));canRemoveRecords=await api('/rest/v1/rpc/ci_can_remove_records',{method:'POST',body:'{}'});localStorage.setItem(permissionKey+'_owner',String(canRemoveRecords));}
 else if(Date.now()-Number(localStorage.getItem(permissionKey)||0)>7*86400000)throw new Error('Connect to the internet and sign in before using this device offline.');
 if(!navigator.onLine)canRemoveRecords=localStorage.getItem(permissionKey+'_owner')==='true';document.body.classList.toggle('no-removals',!canRemoveRecords);
 if(db)db.close();DB_NAME=CI_CONFIG.databaseName+'-'+currentUserId;await openDB();
 cloudAdapter=CISyncAdapter.create({url:SUPABASE_URL,publishableKey:SUPABASE_KEY,getToken:async()=>{accessToken=await account.token();return accessToken;},toProject:rowToProject});
 offlineEngine=CIOffline.create(db,{adapter:cloudAdapter,onStatus:syncStatus});
 projects=(await getAll('projects')).filter(p=>!p._archived);projects.forEach(migrateProject);
 if(navigator.onLine){try{await offlineEngine.flush();await pullCloud();cloudReady=true;}catch(error){if(!projects.length)throw error;setSync('Connection unavailable · showing device copy','bad');}}
 currentId=localStorage.getItem(selectionKey())||projects[0]?.id;if(!projects.some(p=>p.id===currentId))currentId=projects[0]?.id;
 authGate.classList.add('hidden');renderAll();window.dispatchEvent(new Event('ci:ready'));
 if(!navigator.onLine)setSync('Offline · saved on device','ok');
 clearInterval(syncTimer);syncTimer=setInterval(()=>offlineEngine.flush().catch(console.error),30000);
}
async function refreshProjects(){if(!account)return;setSync('Checking shared projects…');try{await offlineEngine.flush();await pullCloud();if(!projects.some(p=>p.id===currentId))currentId=projects[0]?.id;renderAll();const queue=await offlineEngine.list();syncStatus(queue.some(x=>x.status==='conflict')?'conflict':queue.length?'pending':'synced');}catch(e){setSync(e.message,'bad');}}
async function reviewSync(){
 if(!offlineEngine?.adapter){await showOfflineStatus();return;}
 const queued=await offlineEngine.list();if(queued.some(x=>x.status==='rejected'))alert('A change was blocked by account permissions. Shared records are preserved. Ask George to review it; your device copy has been kept.');const ids=[...new Set(queued.filter(x=>x.status==='conflict').map(x=>x.projectId))];
 if(!ids.length){await refreshProjects();return;}
 for(const id of ids){const name=projects.find(p=>p.id===id)?.name||'Project';if(confirm(name+' has edits from another device. Keep your changes as a separate project copy and load the shared version? Both versions will be preserved.'))await offlineEngine.resolveAsCopy(id);}
 await refreshProjects();
}
async function init(){
 if(CI_CONFIG.cloudEnabled){try{if(await restoreSession())await startCloud();else authGate.classList.remove('hidden');}catch(error){authErr.textContent=error.message;authGate.classList.remove('hidden');}return;}
 await openDB();offlineEngine=CIOffline.create(db,{onStatus:syncStatus});projects=await getAll('projects');projects.forEach(migrateProject);
 currentId=localStorage.getItem(selectionKey())||projects[0]?.id;if(!projects.some(p=>p.id===currentId))currentId=projects[0]?.id;
 authGate.classList.add('hidden');renderAll();setSync('On this device','ok');window.dispatchEvent(new Event('ci:ready'));
}

function current(){return projects.find(p=>p.id===currentId)}
async function persist(){
 const p=current();if(!p)return;
 const previous=await get('projects',p.id);
 p.activity=CIData.nextActivity(previous,p,account?.current()?.user?.email||'Development user');
 try{await offlineEngine.save(p);}catch(error){if(error.name!=='LocalConflict'||!confirm(error.message+'\n\nSave your edit as a separate project copy?'))throw error;const copy=structuredClone(p);copy.id=uid();copy.name=(copy.name||'Project')+' — local copy';delete copy.cloudId;delete copy._localRevision;await offlineEngine.save(copy);projects.push(copy);currentId=copy.id;fillDetails();}syncStatus(offlineEngine.adapter?'pending':'local');if(offlineEngine.adapter)offlineEngine.flush().catch(console.error);
 document.getElementById('saveState').textContent='Saved '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
 renderHeader();renderPicker();updateStats();if(typeof renderActivity==='function')renderActivity();
}

function renderHeader(){const p=current();document.getElementById('headerProject').textContent=p?p.name||'Untitled project':'No project selected'}
function renderPicker(){
 const box=document.getElementById('projectList');
 box.innerHTML=projects.slice().sort((a,b)=>b.created-a.created).map(p=>{
   const done=p.checklist.filter(x=>x.status==='green').length,total=p.checklist.length,open=p.issues.filter(x=>x.status==='Open').length;
   return `<div class="card projectCard ${p.id===currentId?'active':''}" onclick="selectProject('${p.id}')"><div class="row"><div><div class="title">${esc(p.name||'Untitled project')}</div><div class="muted">${esc(p.address||'No address')}</div></div><span class="badge ${open?'bad':'good'}">${open} open</span></div><div style="margin-top:10px"><div class="progress"><div class="bar" style="width:${total?done/total*100:0}%"></div></div><div class="tiny" style="margin-top:5px">${done}/${total} stages complete</div></div></div>`
 }).join('');
}
async function selectProject(id){currentId=id;localStorage.setItem(selectionKey(),id);document.getElementById('appArea').classList.remove('hidden');renderAll()}
async function newProject(){
 const name=prompt('Project name','New project');if(!name)return;
 const p=blankProject(name.trim());p.activity=CIData.nextActivity(null,p,account?.current()?.user?.email||'Development user');await offlineEngine.save(p);projects.push(p);currentId=p.id;localStorage.setItem(selectionKey(),p.id);syncStatus(offlineEngine.adapter?'pending':'local');if(offlineEngine.adapter)offlineEngine.flush().catch(console.error);renderAll();showTab('overview',document.querySelector('.tab'));
}
async function deleteCurrentProject(){if(!requireRemovalPermission())return;
 const p=current();if(!p)return;if(CI_CONFIG.cloudEnabled){if(!confirm('Archive this project? Its shared records and files will be preserved.'))return;p._archived=true;await persist();projects=projects.filter(x=>x.id!==p.id);currentId=projects[0]?.id;renderAll();return;}if(!confirm(`Delete "${p.name||'this project'}" and all its information? This cannot be undone.`))return;
 for(const it of p.issues)for(const ph of (it.photos||[])){await del('photos',ph.id);dropThumb(ph.id)}
 for(const ph of p.bcPhotos||[]){await del('photos',ph.id);dropThumb(ph.id)}
 for(const u of p.urgent||[])for(const ph of u.photos||[]){await del('photos',ph.id);dropThumb(ph.id)}
 for(const f of [...(p.files||[]),...(p.hsFiles||[])])await del('planFiles',f.id);
 for(const d of p.diary||[])for(const f of (d.files||[]))await del('changeFiles',f.id);
 await del('projects',p.id);projects=await getAll('projects');
 if(!projects.length){const n=blankProject();await put('projects',n);projects=[n]}
 currentId=projects[0].id;localStorage.setItem(selectionKey(),currentId);renderAll()
}
function fillDetails(){
 const p=current();if(!p)return;
 pName.value=p.name;pManager.value=p.manager;pAddress.value=p.address;pRef.value=p.ref;pStart.value=p.start||'';pTarget.value=p.target||'';pNotes.value=p.notes||'';
}
async function saveProjectDetails(){
 const p=current();Object.assign(p,{name:pName.value.trim(),manager:pManager.value.trim(),address:pAddress.value.trim(),ref:pRef.value.trim(),start:pStart.value,target:pTarget.value,notes:pNotes.value});await persist()
}
function showTab(id,btn){
 document.querySelectorAll('.panel').forEach(x=>x.classList.add('hidden'));document.getElementById(id).classList.remove('hidden');
 document.querySelectorAll('.tab').forEach(x=>{x.classList.remove('active');x.setAttribute('aria-pressed','false')});if(btn){btn.classList.add('active');btn.setAttribute('aria-pressed','true');btn.scrollIntoView({block:'nearest',inline:'nearest'});}
 if(id==='report')renderReport();
 if(id==='bc')renderBC();
 if(id==='hs')renderHS();
 if(id==='urgent')renderUrgent();
 if(id==='backup')renderStorage();
}
const STATUS_LABEL={red:'Not started',amber:'In progress',green:'Complete'};
function scheduleStatus(p){
 const total=p.checklist.length,done=p.checklist.filter(x=>x.status==='green').length;
 const pct=total?Math.round(done/total*100):0;
 if(!p.start||!p.target)return {pct,state:'unknown',msg:'Add a start date and target completion date (and save) to see if you\'re ahead or behind schedule.'};
 const DAY=86400000,start=new Date(p.start+'T00:00'),end=new Date(p.target+'T00:00'),now=new Date(today()+'T00:00');
 const span=(end-start)/DAY;if(span<=0)return {pct,state:'unknown',msg:'Target completion date needs to be after the start date.'};
 const elapsed=Math.min(Math.max((now-start)/DAY,0),span),expected=Math.round(elapsed/span*100),left=Math.round((end-now)/DAY);
 const daysTxt=left>0?`${left} day${left===1?'':'s'} to target completion`:left===0?'Target completion is today':`${-left} day${left===-1?'':'s'} past target completion`;
 let state;
 if(pct>=100)state='done';
 else if(now<start)state='notstarted';
 else if(left<0||pct<expected-5)state='behind';
 else if(pct>expected+5)state='ahead';
 else state='ontime';
 const msg={done:'All stages complete.',notstarted:'Job hasn\'t started yet.',ahead:`Ahead of schedule: ${pct}% done, we should be about ${expected}% by now.`,ontime:`On schedule: ${pct}% done, we should be about ${expected}% by now.`,behind:`Behind schedule: ${pct}% done, we should be about ${expected}% by now.`}[state];
 return {pct,expected,state,msg,daysTxt:state==='done'?'':daysTxt};
}
function renderWorkProgress(p){
 const s=scheduleStatus(p);
 wpFill.style.width=s.pct+'%';wpPct.textContent=s.pct+'% complete';
 const showMark=s.expected!==undefined&&!['done','notstarted'].includes(s.state);
 wpMark.classList.toggle('hidden',!showMark);if(showMark)wpMark.style.left=s.expected+'%';
 const badge={ahead:['good','AHEAD'],ontime:['good','ON TIME'],behind:['bad','BEHIND'],done:['good','COMPLETE'],notstarted:['blue','NOT STARTED'],unknown:['blue','NO SCHEDULE']}[s.state];
 wpSchedule.innerHTML=`<div class="schedule"><span class="badge ${badge[0]}" style="font-size:12px">${badge[1]}</span><span>${esc(s.msg)}</span></div>${s.daysTxt?`<div class="tiny" style="margin-top:4px">${esc(s.daysTxt)}${showMark?' • the dark line on the bar shows where we should be today':''}</div>`:''}`;
}
function updateStats(){
 const p=current();if(!p)return;const done=p.checklist.filter(x=>x.status==='green').length,total=p.checklist.length,open=p.issues.filter(x=>x.status==='Open').length;
 renderWorkProgress(p);
 sDone.textContent=done;sOpen.textContent=total-done;sMat.textContent=p.materials.filter(m=>!m.delivered).length;{const n=(p.urgent||[]).filter(u=>u.status!=='green').length;urgentCount.textContent=n;urgentCount.classList.toggle('hidden',!n)}sIssue.textContent=open;bar.style.width=(total?done/total*100:0)+'%';
}
function renderChecklist(){
 const p=current();if(!p)return;let arr=p.checklist.filter(x=>filterMode==='all'||(filterMode==='done'?x.status==='green':x.status!=='green'));
 checkItems.innerHTML=arr.length?arr.map(x=>{const mc=stageMatCounts(p,x.id);return `<div class="item ${x.status}">
 <div class="row"><div style="flex:1"><div class="title">${esc(x.title)}</div><div class="muted">${STATUS_LABEL[x.status]}${x.date?' • '+esc(x.date):''}</div>${mc.total?`<div style="margin-top:4px"><span class="badge ${mc.done===mc.total?'good':'bad'}">Materials: ${mc.done}/${mc.total} delivered</span></div>`:''}</div>
 <div class="statusBtns">
 <button class="statusBtn sRed ${x.status==='red'?'active':''}" title="Not started" onclick="setStatus('${x.id}','red')"></button>
 <button class="statusBtn sAmber ${x.status==='amber'?'active':''}" title="In progress" onclick="setStatus('${x.id}','amber')"></button>
 <button class="statusBtn sGreen ${x.status==='green'?'active':''}" title="Complete" onclick="setStatus('${x.id}','green')"></button>
 </div>
 <button class="danger small" onclick="delCheck('${x.id}')">Delete</button></div>
 <div class="grid" style="margin-top:10px"><div><label>Completion date</label><input type="date" value="${esc(x.date||'')}" onchange="updateCheck('${x.id}','date',this.value)"></div><div><label>Stage notes / comments</label><input value="${esc(x.notes||'')}" placeholder="What was done / what remains?" onchange="updateCheck('${x.id}','notes',this.value)"></div></div>
 </div>`}).join(''):'<div class="empty">Nothing here.</div>';
}
function filterChecklist(m){filterMode=m;renderChecklist()}
async function setStatus(id,status){const x=current().checklist.find(x=>x.id===id);x.status=status;if(status==='green'&&!x.date)x.date=today();await persist();renderChecklist();renderPicker()}
async function updateCheck(id,k,v){const x=current().checklist.find(x=>x.id===id);x[k]=v;await persist()}
async function delCheck(id){if(!requireRemovalPermission())return;if(!confirm('Delete this checklist item?'))return;current().checklist=current().checklist.filter(x=>x.id!==id);await persist();renderChecklist();renderPicker();renderMaterials()}
async function addChecklist(){const n=prompt('Checklist item');if(!n)return;current().checklist.push({id:uid(),title:n,status:'red',date:'',notes:''});await persist();renderChecklist();renderPicker();renderMaterials()}

/* ---------- Materials, grouped by checklist stage ---------- */
let matFilter='all';
// Stages come from the project's checklist (including any custom items), plus a catch-all for unassigned materials.
function matStages(p){return [...p.checklist.map(c=>({id:c.id,title:c.title})),{id:'',title:'General / not assigned to a stage'}]}
function matStageId(p,m){return p.checklist.some(c=>c.id===m.stageId)?m.stageId:''}
function stageMatCounts(p,stageId){const ms=p.materials.filter(m=>matStageId(p,m)===stageId);return {total:ms.length,done:ms.filter(m=>m.delivered).length}}
function filterMaterials(f){matFilter=f;renderMaterials()}
function renderMaterials(){
 const p=current();if(!p)return;
 const total=p.materials.length,done=p.materials.filter(m=>m.delivered).length;
 matSummary.textContent=total?`${done} of ${total} delivered • ${total-done} awaiting delivery`:'No materials yet. Use "+ Add material" on a stage.';
 const stages=matStages(p);
 const html=stages.map(s=>{
   let ms=p.materials.filter(m=>matStageId(p,m)===s.id);
   const all=ms.length,got=ms.filter(m=>m.delivered).length;
   if(matFilter==='open')ms=ms.filter(m=>!m.delivered);
   if(matFilter==='done')ms=ms.filter(m=>m.delivered);
   if(matFilter!=='all'&&!ms.length)return '';
   if(s.id===''&&!all&&matFilter==='all')return `<div class="item"><div class="row"><div style="flex:1;min-width:0"><div class="title">${esc(s.title)}</div></div><button class="secondary small" onclick="addMaterial('')">+ Add material</button></div></div>`;
   const cls=!all?'':got===all?'green':'red';
   return `<div class="item ${cls}">
   <div class="row"><div style="flex:1;min-width:0"><div class="title">${esc(s.title)}</div><div class="muted">${all?`${got} of ${all} delivered`:'No materials listed'}</div></div><button class="secondary small" onclick="addMaterial('${s.id}')">+ Add material</button></div>
   ${ms.map(m=>matRow(p,m,stages)).join('')}
   </div>`}).join('');
 matItems.innerHTML=html||'<div class="empty">Nothing here.</div>';
}
function matRow(p,m,stages){
 const sid=matStageId(p,m);
 return `<div class="fileRow" style="display:block;border-left:4px solid ${m.delivered?'var(--good)':'var(--bad)'}">
 <div class="row" style="align-items:flex-start"><div style="flex:1;min-width:0">
   <div class="grid"><div><label>Material</label><input value="${esc(m.name||'')}" placeholder="e.g. 100mm blocks" onchange="updateMat('${m.id}','name',this.value)"></div>
   <div><label>Quantity</label><input value="${esc(m.qty||'')}" placeholder="e.g. 400" onchange="updateMat('${m.id}','qty',this.value)"></div></div>
 </div>
 <div style="text-align:center"><label>Delivered?</label><div class="statusBtns">
   <button class="statusBtn sRed ${m.delivered?'':'active'}" title="Not delivered" aria-label="Not delivered" onclick="setDelivered('${m.id}',false)"></button>
   <button class="statusBtn sGreen ${m.delivered?'active':''}" title="Delivered" aria-label="Delivered" onclick="setDelivered('${m.id}',true)"></button>
 </div></div></div>
 <div class="tiny" style="margin-top:6px">${m.delivered?'<span class="badge good">Delivered</span>'+(m.deliveredDate?' '+esc(m.deliveredDate):''):'<span class="badge bad">Not delivered</span>'}</div>
 <div class="grid" style="margin-top:8px"><div><label>Notes</label><input value="${esc(m.comment||'')}" placeholder="Supplier, order no., delivery date…" onchange="updateMat('${m.id}','comment',this.value)"></div>
 <div><label>Stage</label><select onchange="updateMat('${m.id}','stageId',this.value,true)">${stages.map(s=>`<option value="${s.id}" ${s.id===sid?'selected':''}>${esc(s.title)}</option>`).join('')}</select></div></div>
 <div class="actions" style="margin-top:8px"><button class="danger small" onclick="delMaterial('${m.id}')">Delete</button></div>
 </div>`;
}
async function updateMat(id,k,v,rerender){const m=current().materials.find(x=>x.id===id);if(!m)return;m[k]=v;await persist();if(rerender){renderMaterials();renderChecklist()}}
async function setDelivered(id,val){const m=current().materials.find(x=>x.id===id);if(!m)return;m.delivered=val;m.deliveredDate=val?(m.deliveredDate||today()):'';await persist();renderMaterials();renderChecklist()}
async function addMaterial(stageId){current().materials.push({id:uid(),stageId:stageId||'',name:'',qty:'',delivered:false,deliveredDate:'',comment:''});await persist();if(matFilter==='done')matFilter='all';renderMaterials();renderChecklist()}
async function delMaterial(id){if(!requireRemovalPermission())return;if(!confirm('Delete this material?'))return;current().materials=current().materials.filter(x=>x.id!==id);await persist();renderMaterials();renderChecklist()}

const CHANGE_CHIP={'Customer change':'chipCust','Architect change':'chipArch','Site instruction':'chipSite','Other':'chipOther'};
function renderDiary(){
 const p=current();diaryItems.innerHTML=p.diary.slice().sort((a,b)=>b.date.localeCompare(a.date)).map((d,i)=>`<div class="item">
 <div class="row"><span class="chip ${CHANGE_CHIP[d.type]||'chipOther'}">${esc(d.type||'Other')}</span><button class="danger small" onclick="delDiary('${d.id}')">Delete</button></div>
 <div class="grid3" style="margin-top:10px"><div><label>Date</label><input type="date" value="${esc(d.date)}" onchange="updateDiary('${d.id}','date',this.value)"></div>
 <div><label>Change type</label><select onchange="updateDiary('${d.id}','type',this.value)"><option ${d.type==='Customer change'?'selected':''}>Customer change</option><option ${d.type==='Architect change'?'selected':''}>Architect change</option><option ${d.type==='Site instruction'?'selected':''}>Site instruction</option><option ${d.type==='Other'?'selected':''}>Other</option></select></div>
 <div><label>Instructed by</label><input value="${esc(d.people||'')}" placeholder="Customer / architect name" onchange="updateDiary('${d.id}','people',this.value)"></div></div>
 <div style="margin-top:10px"><label>Description of variation</label><textarea placeholder="What is changing and why..." onchange="updateDiary('${d.id}','text',this.value)">${esc(d.text||'')}</textarea></div>
 <div style="margin-top:10px"><label>Attach instruction / marked-up drawing (photo or PDF)</label><input type="file" accept="application/pdf,image/*" multiple onchange="addChangeFiles('${d.id}',this.files)">
 <div class="fileListSmall">${(d.files||[]).map(f=>`<div class="fileRow"><div><div class="fname">${esc(f.name)}</div><div class="fmeta">${esc(f.mime||'')}</div></div><div class="actions"><button class="secondary small" onclick="viewChangeFile('${f.id}')">View</button><button class="danger small" onclick="delChangeFile('${d.id}','${f.id}')">Delete</button></div></div>`).join('')}</div>
 </div>
 </div>`).join('')||'<div class="empty">No plan variations recorded yet.</div>';
}
async function addDiary(){current().diary.push({id:uid(),date:today(),type:'Customer change',people:'',text:'',files:[]});await persist();renderDiary()}
async function updateDiary(id,k,v){const d=current().diary.find(x=>x.id===id);d[k]=v;await persist();if(k==='type')renderDiary()}
async function delDiary(id){if(!requireRemovalPermission())return;const d=current().diary.find(x=>x.id===id);for(const f of (d&&d.files)||[])await del('changeFiles',f.id);current().diary=current().diary.filter(x=>x.id!==id);await persist();renderDiary()}
async function addChangeFiles(entryId,fileList){
 const d=current().diary.find(x=>x.id===entryId);const p=current();
 for(const f of [...fileList]){
   const id=uid();const blob=f;const path=storagePath(p.cloudId||p.id,id,f.name);
   toast(`Uploading ${f.name}…`,true);await uploadCloudFile(path,blob,f.type);
   const rec={id,name:f.name,mime:f.type,blob,path};await put('changeFiles',rec);d.files.push({id,name:f.name,mime:f.type,path,size:blob.size,date:today()});
   await persist();
 }
 renderDiary();toast('File upload complete');
}
async function viewChangeFile(id){
 try{
  let obj=await get('changeFiles',id);let blob=obj?.blob||null;
  if(!blob){const path=cloudFilePathForId(id);if(path)blob=await cloudBlob(path)}
  if(!blob)return;
  await openPdfInApp(blob,obj?.name||'Variation document');
 }catch(e){console.error(e);alert('Could not open this file. Please try again.')}
}
async function delChangeFile(entryId,fileId){if(!requireRemovalPermission())return;const d=current().diary.find(x=>x.id===entryId);d.files=d.files.filter(f=>f.id!==fileId);await del('changeFiles',fileId);await persist();renderDiary()}

function renderIssues(){
 const p=current();issueItems.innerHTML=p.issues.length?p.issues.map(it=>`<div class="item">
 <div class="row"><span class="badge ${it.status==='Open'?'bad':'good'}">${it.status}</span><div class="actions"><button class="secondary small" onclick="toggleIssue('${it.id}')">${it.status==='Open'?'Mark rectified':'Re-open'}</button><button class="danger small" onclick="delIssue('${it.id}')">Delete</button></div></div>
 <div class="grid3" style="margin-top:10px"><div><label>Location / item</label><input value="${esc(it.title)}" onchange="updateIssue('${it.id}','title',this.value)"></div>
 <div><label>Priority</label><select onchange="updateIssue('${it.id}','priority',this.value)"><option ${it.priority==='Low'?'selected':''}>Low</option><option ${it.priority==='Medium'?'selected':''}>Medium</option><option ${it.priority==='High'?'selected':''}>High</option></select></div>
 <div><label>Responsible person / trade</label><input value="${esc(it.responsible||'')}" onchange="updateIssue('${it.id}','responsible',this.value)"></div></div>
 <div style="margin-top:10px"><label>What needs rectifying?</label><textarea onchange="updateIssue('${it.id}','comment',this.value)">${esc(it.comment||'')}</textarea></div>
 <div style="margin-top:10px"><label>Add photos</label><input type="file" accept="image/*" multiple onchange="addPhotos('${it.id}',this.files);this.value=''"><div class="photos" id="photos-${it.id}">${(it.photos||[]).map(ph=>`<span class="photoWrap"><img data-pid="${ph.id}" alt="Snag photo" onclick="openViewer('snag','${it.id}','${ph.id}')"><button class="photoDel" onclick="removePhoto('${it.id}','${ph.id}')">×</button></span>`).join('')}</div></div>
 </div>`).join(''):'<div class="empty">No snags or rectifications recorded.</div>';
 loadThumbs(issueItems);
}
async function updateIssue(id,k,v){const it=current().issues.find(x=>x.id===id);it[k]=v;await persist();renderIssues()}
async function addIssue(){current().issues.unshift({id:uid(),title:'',priority:'Medium',status:'Open',responsible:'',comment:'',photos:[]});await persist();renderIssues()}
async function delIssue(id){if(!requireRemovalPermission())return;if(!confirm('Delete this snag and its photos?'))return;const it=current().issues.find(x=>x.id===id);for(const ph of it.photos||[])await del('photos',ph.id);current().issues=current().issues.filter(x=>x.id!==id);await persist();renderIssues();renderPicker()}
async function toggleIssue(id){const it=current().issues.find(x=>x.id===id);it.status=it.status==='Open'?'Rectified':'Open';it.rectifiedDate=it.status==='Rectified'?today():'';await persist();renderIssues();renderPicker()}
async function addPhotos(id,files){
 const list=[...files];
 for(let i=0;i<list.length;i++){
   toast(`Saving photo ${i+1} of ${list.length}…`,true);
   const ph=await storeImage(list[i]);
   const it=current().issues.find(x=>x.id===id);if(!it)break;if(!it.photos)it.photos=[];
   it.photos.push({id:ph.id,name:ph.name,path:ph.path});
   await persist();
 }
 toast(list.length+' photo'+(list.length===1?'':'s')+' saved');
 renderIssues();
}
function blobToData(blob){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(blob)})}
async function removePhoto(issueId,photoId,noConfirm){if(!requireRemovalPermission())return;if(!noConfirm&&!confirm('Delete this photo?'))return;const it=current().issues.find(x=>x.id===issueId);it.photos=it.photos.filter(x=>x.id!==photoId);await del('photos',photoId);dropThumb(photoId);await persist();renderIssues()}

/* ---------- Photo storage helpers ---------- */
function toast(msg,sticky){const t=document.getElementById('toast');t.textContent=msg;t.classList.remove('hidden');clearTimeout(toast._t);if(!sticky)toast._t=setTimeout(()=>t.classList.add('hidden'),2600)}
async function requestPersist(){try{if(navigator.storage&&navigator.storage.persist&&!(await navigator.storage.persisted()))await navigator.storage.persist()}catch(e){}}
function isImage(f){return /^image\//i.test(f.type||'')||/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name||'')}
function decodeImage(blob){return new Promise((res,rej)=>{const url=URL.createObjectURL(blob);const img=new Image();img.onload=()=>res({img,url});img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('Could not read image'))};img.src=url})}
async function resizeImage(blob,maxDim,q){
 const {img,url}=await decodeImage(blob);
 try{
   const w=img.naturalWidth,h=img.naturalHeight;if(!w||!h)throw new Error('Empty image');
   const s=Math.min(1,maxDim/Math.max(w,h));const c=document.createElement('canvas');c.width=Math.round(w*s);c.height=Math.round(h*s);
   const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);
   const out=await new Promise(r=>c.toBlob(r,'image/jpeg',q));c.width=c.height=0;return out;
 }finally{URL.revokeObjectURL(url)}
}
async function compressPhoto(file,maxDim=PHOTO_MAX,q=PHOTO_Q){
 if(!isImage(file)||/gif$/i.test(file.type||''))return file;
 try{const out=await resizeImage(file,maxDim,q);if(out&&out.size<file.size)return out}catch(e){}
 return file;
}
// Saves one image once (resized), plus a small thumbnail for fast lists. Returns {id,name}.
async function storeImage(file){
 const blob=await compressPhoto(file);
 let thumb=null;try{thumb=await resizeImage(blob,THUMB_MAX,THUMB_Q)}catch(e){}
 const name=(file.name||'photo').replace(/\.(heic|heif|png|webp)$/i,'.jpg');
 const id=uid();const p=current();const path=storagePath(p?.cloudId||p?.id,id,name);
 await uploadCloudFile(path,blob,blob.type||file.type||'image/jpeg');
 const rec={id,name,type:blob.type||file.type,blob,thumb,added:Date.now(),path};
 await put('photos',rec);requestPersist();
 return {id,name,path};
}
function dropThumb(id){const u=thumbUrls.get(id);if(u){URL.revokeObjectURL(u);thumbUrls.delete(id)}}
async function loadThumbs(root){
 for(const img of [...root.querySelectorAll('img[data-pid]')]){
   const id=img.dataset.pid;let url=thumbUrls.get(id);
   if(!url){
     const rec=await getPhotoRecord(id);if(!rec||!rec.blob)continue;
     let t=rec.thumb;
     if(!t){try{t=await resizeImage(rec.blob,THUMB_MAX,THUMB_Q);if(t){rec.thumb=t;await put('photos',rec)}}catch(e){}}
     url=URL.createObjectURL(t||rec.blob);thumbUrls.set(id,url);
   }
   img.src=url;
 }
}
// Older versions kept a full-size text copy of every snag photo inside the project record. Remove it (the photo itself is kept).
async function migrateSnagPhotoData(){
 for(const p of projects){
   let changed=false;
   for(const it of p.issues||[])for(const ph of it.photos||[]){
     if(ph.data!==undefined){
       if(!(await get('photos',ph.id))&&String(ph.data).startsWith('data:')){
         try{const blob=await (await fetch(ph.data)).blob();await put('photos',{id:ph.id,name:ph.name,type:blob.type,blob})}catch(e){continue}
       }
       delete ph.data;changed=true;
     }
   }
   if(changed)await put('projects',p);
 }
 projects=await getAll('projects');
}
function fmtMB(b){return b>=1073741824?(b/1073741824).toFixed(1)+' GB':(b/1048576).toFixed(b<10485760?1:0)+' MB'}
async function renderStorage(){
 const all=await getAll('projects');
 let bc=0,snag=0,docs=0;all.forEach(p=>{bc+=(p.bcPhotos||[]).length;(p.issues||[]).forEach(i=>snag+=(i.photos||[]).length);(p.urgent||[]).forEach(u=>snag+=(u.photos||[]).length);docs+=(p.files||[]).length+(p.hsFiles||[]).length;(p.diary||[]).forEach(d=>docs+=(d.files||[]).length)});
 let txt=`${all.length} project${all.length===1?'':'s'} • ${bc} Building Control photo${bc===1?'':'s'} • ${snag} snag / urgent photo${snag===1?'':'s'} • ${docs} document${docs===1?'':'s'}`;
 let pct=0;
 try{if(navigator.storage&&navigator.storage.estimate){const e=await navigator.storage.estimate();if(e.quota){pct=Math.min(100,e.usage/e.quota*100);txt+=`<br>Using <b>${fmtMB(e.usage||0)}</b> of about ${fmtMB(e.quota)} available to this app.`}}}catch(e){}
 storageInfo.innerHTML=txt;storageBar.style.width=Math.max(pct,pct?1:0)+'%';storageBar.style.background=pct>80?'var(--bad)':pct>60?'var(--warn)':'var(--good)';
 let persisted=false;try{persisted=navigator.storage&&navigator.storage.persisted?await navigator.storage.persisted():false}catch(e){}
 storagePersist.innerHTML=persisted?'<span class="badge good">Protected</span> The browser won\'t clear this app\'s data to free up space.':'<span class="badge warn">Not protected</span> On iPhone, add the app to your Home Screen and open it from there. Otherwise Safari can clear saved data if the app isn\'t opened for a few weeks. Keep exporting backups either way.';
}
async function optimiseExisting(){if(!requireRemovalPermission())return;
 if(!confirm('This shrinks large photos already saved on this device and removes leftover files from deleted projects. It can take a minute. Continue?'))return;
 toast('Tidying up…',true);
 const all=await getAll('projects');
 const refPhotos=new Set(),refPlans=new Set(),refChanges=new Set();
 all.forEach(p=>{(p.issues||[]).forEach(i=>(i.photos||[]).forEach(ph=>refPhotos.add(ph.id)));(p.bcPhotos||[]).forEach(ph=>refPhotos.add(ph.id));(p.urgent||[]).forEach(u=>(u.photos||[]).forEach(ph=>refPhotos.add(ph.id)));(p.files||[]).forEach(f=>refPlans.add(f.id));(p.hsFiles||[]).forEach(f=>refPlans.add(f.id));(p.diary||[]).forEach(d=>(d.files||[]).forEach(f=>refChanges.add(f.id)))});
 let saved=0,removed=0,shrunk=0;
 const photoIds=await new Promise((res,rej)=>{const r=tx('photos').getAllKeys();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
 for(let i=0;i<photoIds.length;i++){
   const id=photoIds[i];toast(`Checking photo ${i+1} of ${photoIds.length}…`,true);
   const rec=await get('photos',id);if(!rec)continue;
   if(!refPhotos.has(id)){saved+=rec.blob?rec.blob.size:0;await del('photos',id);removed++;continue}
   if(rec.blob&&rec.blob.size>900*1024){
     // Only shrink photos larger than the new size limit, so already-optimised photos aren't recompressed.
     let big=false;try{const {img,url}=await decodeImage(rec.blob);big=Math.max(img.naturalWidth,img.naturalHeight)>PHOTO_MAX;URL.revokeObjectURL(url)}catch(e){}
     if(!big)continue;
     const out=await compressPhoto(rec.blob);
     if(out!==rec.blob&&out.size<rec.blob.size){saved+=rec.blob.size-out.size;rec.blob=out;rec.type=out.type;try{rec.thumb=await resizeImage(out,THUMB_MAX,THUMB_Q)}catch(e){}await put('photos',rec);dropThumb(id);shrunk++}
   }
 }
 for(const [store,ref] of [['planFiles',refPlans],['changeFiles',refChanges]]){
   const keys=await new Promise((res,rej)=>{const r=tx(store).getAllKeys();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
   for(const id of keys)if(!ref.has(id)){const rec=await get(store,id);saved+=rec&&rec.blob?rec.blob.size:0;await del(store,id);removed++}
 }
 toast(`Done: ${shrunk} photo${shrunk===1?'':'s'} shrunk, ${removed} leftover file${removed===1?'':'s'} removed, about ${fmtMB(saved)} freed.`);
 renderStorage();
}

/* ---------- Building Control photos ---------- */
function bcStageOf(ph){return BC_STAGES.includes(ph.stage)?ph.stage:'Other'}
function slug(s){return String(s||'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,40)||'photo'}
function renderBC(){
 const p=current();if(!p)return;const list=p.bcPhotos||[];
 const stagesWith=new Set(list.map(bcStageOf)).size;
 bcSummary.textContent=list.length?`${list.length} photo${list.length===1?'':'s'} across ${stagesWith} stage${stagesWith===1?'':'s'}`:'No photos yet. Use "+ Add photos" on a stage to take a photo or pick from the camera roll.';
 bcStages.innerHTML=BC_STAGES.map((s,si)=>{
   const ph=list.filter(x=>bcStageOf(x)===s).sort((a,b)=>(a.added||0)-(b.added||0));
   return `<div class="item ${ph.length?'green':''}">
   <div class="row"><div style="flex:1;min-width:0"><div class="title">${esc(s)}</div></div><span class="bcCount ${ph.length?'has':''}">${ph.length}</span></div>
   ${ph.length?`<div class="photos">${ph.map(x=>`<span class="photoWrap"><img data-pid="${x.id}" alt="${esc(x.caption||s)}" onclick="openViewer('bc',null,'${x.id}')">${x.caption?`<span class="photoCap">${esc(x.caption)}</span>`:''}</span>`).join('')}</div>`:''}
   <div class="actions" style="margin-top:10px"><button class="secondary small" onclick="pickBC(${si})">+ Add photos</button>${ph.length?`<button class="secondary small" onclick="shareBC(${si})">Share / save all</button>`:''}</div>
   </div>`}).join('');
 loadThumbs(bcStages);
}
function pickBC(si){bcPendingStage=BC_STAGES[si];document.getElementById('bcInput').click()}
async function addBCPhotos(files){
 if(!current()||!files||!files.length)return;
 const stage=bcPendingStage||'Other';const list=[...files];
 for(let i=0;i<list.length;i++){
   toast(`Saving photo ${i+1} of ${list.length}…`,true);
   const ph=await storeImage(list[i]);
   const p=current();if(!p.bcPhotos)p.bcPhotos=[]; // re-read each time: persist() reloads the project
   p.bcPhotos.push({id:ph.id,name:ph.name,path:ph.path,stage,caption:'',date:today(),added:Date.now()});
   await persist();
 }
 toast(`${list.length} photo${list.length===1?'':'s'} added to ${stage}`);
 renderBC();
}
async function updateBCPhoto(id,k,v){const ph=current().bcPhotos.find(x=>x.id===id);if(!ph)return;ph[k]=v;await persist();renderBC()}
async function removeBCPhoto(id){if(!requireRemovalPermission())return;const p=current();p.bcPhotos=p.bcPhotos.filter(x=>x.id!==id);await del('photos',id);dropThumb(id);await persist();renderBC()}
async function bcFile(ph,n){
 const rec=await getPhotoRecord(ph.id);if(!rec)return null;const p=current();
 const name=`${slug(p.ref||p.name)}_${slug(bcStageOf(ph))}_${n}.jpg`;
 return new File([rec.blob],name,{type:rec.type||'image/jpeg'});
}
function downloadFile(file){const a=document.createElement('a');a.href=URL.createObjectURL(file);a.download=file.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}
async function shareFiles(files,title){
 files=files.filter(Boolean);if(!files.length)return;
 if(navigator.canShare&&navigator.canShare({files})){try{await navigator.share({files,title})}catch(e){}return}
 for(const f of files){downloadFile(f);await new Promise(r=>setTimeout(r,400))}
}
async function shareBC(si){
 const stage=BC_STAGES[si];const ph=current().bcPhotos.filter(x=>bcStageOf(x)===stage).sort((a,b)=>(a.added||0)-(b.added||0));
 const files=[];for(let i=0;i<ph.length;i++)files.push(await bcFile(ph[i],i+1));
 await shareFiles(files,stage);
}

/* ---------- Full-size photo viewer ---------- */
let viewer={kind:null,ids:[],idx:0,issueId:null,url:null};
function openViewer(kind,issueId,photoId){
 const p=current();let ids;
 if(kind==='bc'){const ph=p.bcPhotos.find(x=>x.id===photoId);const st=bcStageOf(ph);ids=p.bcPhotos.filter(x=>bcStageOf(x)===st).sort((a,b)=>(a.added||0)-(b.added||0)).map(x=>x.id)}
 else if(kind==='urgent'){const u=p.urgent.find(x=>x.id===issueId);ids=(u.photos||[]).map(x=>x.id)}
 else{const it=p.issues.find(x=>x.id===issueId);ids=(it.photos||[]).map(x=>x.id)}
 viewer={kind,ids,idx:Math.max(0,ids.indexOf(photoId)),issueId,url:viewer.url};
 document.getElementById('viewer').classList.remove('hidden');document.body.style.overflow='hidden';
 showViewerPhoto();
}
function closeViewer(){document.getElementById('viewer').classList.add('hidden');document.body.style.overflow='';if(viewer.url){URL.revokeObjectURL(viewer.url);viewer.url=null}vImg.removeAttribute('src')}
function stepViewer(d){const n=viewer.idx+d;if(n<0||n>=viewer.ids.length)return;viewer.idx=n;showViewerPhoto()}
async function showViewerPhoto(){
 const id=viewer.ids[viewer.idx];const rec=await getPhotoRecord(id);
 if(viewer.url)URL.revokeObjectURL(viewer.url);viewer.url=rec?URL.createObjectURL(rec.blob):null;
 vImg.src=viewer.url||'';vCount.textContent=`Photo ${viewer.idx+1} of ${viewer.ids.length}`;
 vPrev.disabled=viewer.idx===0;vNext.disabled=viewer.idx>=viewer.ids.length-1;
 if(viewer.kind==='bc'){
   const ph=current().bcPhotos.find(x=>x.id===id)||{};
   vBar.innerHTML=`<div class="grid3">
   <div><label>Stage</label><select onchange="updateBCPhoto('${id}','stage',this.value)">${BC_STAGES.map(s=>`<option ${bcStageOf(ph)===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
   <div><label>Date taken</label><input type="date" value="${esc(ph.date||'')}" onchange="updateBCPhoto('${id}','date',this.value)"></div>
   <div><label>Caption / notes</label><input value="${esc(ph.caption||'')}" placeholder="e.g. Trench depth 1.0m to firm clay" onchange="updateBCPhoto('${id}','caption',this.value)"></div></div>
   <div class="actions" style="margin-top:10px"><button class="secondary small" onclick="shareViewerPhoto()">Share / save</button><button class="danger small" onclick="deleteViewerPhoto()">Delete photo</button></div>`;
 }else{
   vBar.innerHTML=`<div class="actions"><button class="secondary small" onclick="shareViewerPhoto()">Share / save</button><button class="danger small" onclick="deleteViewerPhoto()">Delete photo</button></div>`;
 }
}
async function shareViewerPhoto(){
 const id=viewer.ids[viewer.idx];
 if(viewer.kind==='bc'){const ph=current().bcPhotos.find(x=>x.id===id);return shareFiles([await bcFile(ph,viewer.idx+1)])}
 const rec=await getPhotoRecord(id);if(rec)shareFiles([new File([rec.blob],`${slug(current().ref||current().name)}_snag_${viewer.idx+1}.jpg`,{type:rec.type||'image/jpeg'})]);
}
async function deleteViewerPhoto(){if(!requireRemovalPermission())return;
 if(!confirm('Delete this photo?'))return;
 const id=viewer.ids[viewer.idx];
 if(viewer.kind==='bc')await removeBCPhoto(id);else if(viewer.kind==='urgent')await removeUrgentPhoto(viewer.issueId,id,true);else await removePhoto(viewer.issueId,id,true);
 viewer.ids.splice(viewer.idx,1);
 if(!viewer.ids.length)return closeViewer();
 viewer.idx=Math.min(viewer.idx,viewer.ids.length-1);showViewerPhoto();
}
document.addEventListener('keydown',e=>{if(document.getElementById('viewer').classList.contains('hidden')||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(e.key==='Escape')closeViewer();if(e.key==='ArrowLeft')stepViewer(-1);if(e.key==='ArrowRight')stepViewer(1)});

function renderReport(){
 const p=current();if(!p)return;
 const done=p.checklist.filter(x=>x.status==='green').length,total=p.checklist.length,open=p.issues.filter(x=>x.status==='Open').length;
 reportBody.innerHTML=`<div class="reportBrand"><img src="data:image/png;base64,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" alt="" width="44" height="44"><div><div class="reportWord">Construct<span>IQ</span></div><div class="tiny">Site report • ${esc(new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}))}</div></div></div>
 <h1 style="margin-top:0">${esc(p.name||'Untitled project')}</h1>
 <p><b>Project manager:</b> ${esc(p.manager||'—')} &nbsp; <b>Ref:</b> ${esc(p.ref||'—')}</p>
 <p><b>Address:</b> ${esc(p.address||'—')}<br><b>Start:</b> ${esc(p.start||'—')} &nbsp; <b>Target:</b> ${esc(p.target||'—')}</p>
 <h2>Progress</h2><p>${done} of ${total} checklist stages complete (${total?Math.round(done/total*100):0}%).</p>
 <h2>Checklist</h2><table class="table"><tr><th>Stage</th><th>Status</th><th>Date</th><th>Notes</th></tr>${p.checklist.map(x=>`<tr><td>${esc(x.title)}</td><td>${STATUS_LABEL[x.status]||''}</td><td>${esc(x.date||'')}</td><td>${esc(x.notes||'')}</td></tr>`).join('')}</table>
 <h2>Urgent to do</h2>${(p.urgent||[]).length?`<table class="table"><tr><th>Job</th><th>Status</th><th>Raised</th><th>Done</th></tr>${urgentSorted(p).map(u=>`<tr><td>${esc(u.text||'')}</td><td><span class="badge ${u.status==='green'?'good':u.status==='amber'?'warn':'bad'}">${URGENT_LABEL[u.status]}</span></td><td>${esc(u.raised||'')}</td><td>${esc(u.doneDate||'')}</td></tr>`).join('')}</table>`:'<p>None.</p>'}
 <h2>Materials</h2>${p.materials.length?`<p>${p.materials.filter(m=>m.delivered).length} of ${p.materials.length} delivered.</p><table class="table"><tr><th>Stage</th><th>Material</th><th>Qty</th><th>Delivered</th><th>Notes</th></tr>${matStages(p).map(s=>p.materials.filter(m=>matStageId(p,m)===s.id).map(m=>`<tr><td>${esc(s.id?s.title:'General')}</td><td>${esc(m.name||'')}</td><td>${esc(m.qty||'')}</td><td><span class="badge ${m.delivered?'good':'bad'}">${m.delivered?'Yes'+(m.deliveredDate?' '+esc(m.deliveredDate):''):'No'}</span></td><td>${esc(m.comment||'')}</td></tr>`).join('')).join('')}</table>`:'<p>None recorded.</p>'}
 <h2>Plans & Gantt charts</h2>${(p.files||[]).length?`<table class="table"><tr><th>Document</th><th>Type</th><th>Date added</th></tr>${p.files.map(f=>`<tr><td>${esc(f.name)}</td><td>${esc(f.docType)}</td><td>${esc(f.date)}</td></tr>`).join('')}</table>`:'<p>None uploaded.</p>'}
 <h2>Plan variations</h2>${p.diary.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(d=>`<p><b>${esc(d.date)} — ${esc(d.type)}</b> ${d.people?'— instructed by '+esc(d.people):''}<br>${esc(d.text||'')}</p>`).join('')||'<p>None recorded.</p>'}
 <h2>Open snags / rectifications (${open})</h2>${p.issues.filter(i=>i.status==='Open').map(i=>`<p><b>${esc(i.title||'Untitled snag')}</b> — ${esc(i.priority)}${i.responsible?' — '+esc(i.responsible):''}<br>${esc(i.comment||'')}</p>`).join('')||'<p>None.</p>'}
 <h2>Building Control photos</h2>${(p.bcPhotos||[]).length?BC_STAGES.map(s=>{const ph=p.bcPhotos.filter(x=>bcStageOf(x)===s).sort((a,b)=>(a.added||0)-(b.added||0));return ph.length?`<h3 style="margin:10px 0 4px;font-size:15px">${esc(s)} (${ph.length})</h3><div class="reportPhotos">${ph.map(x=>`<figure><img data-pid="${x.id}" alt=""><figcaption>${esc(x.date||'')}${x.caption?' — '+esc(x.caption):''}</figcaption></figure>`).join('')}</div>`:''}).join(''):'<p>None uploaded.</p>'}
 <h2>PPE &amp; safety equipment</h2><table class="table"><tr><th>Item</th><th>Status</th><th>Reported by</th><th>Details</th></tr>${(p.ppe||[]).map(x=>`<tr><td>${esc(x.item)}</td><td><span class="badge ${x.status==='red'?'bad':'good'}">${x.status==='red'?'Needs replacing':'OK'}</span></td><td>${x.status==='red'?esc(x.reportedBy||'')+(x.reportedDate?' ('+esc(x.reportedDate)+')':''):''}</td><td>${x.status==='red'?esc(x.notes||''):(x.replacedDate?'Replaced '+esc(x.replacedDate):'')}</td></tr>`).join('')}</table>
 <h2>Health &amp; safety documents</h2>${(p.hsFiles||[]).length?`<table class="table"><tr><th>Document</th><th>Type</th><th>Date added</th></tr>${p.hsFiles.map(f=>`<tr><td>${esc(f.name)}</td><td>${esc(f.docType)}</td><td>${esc(f.date)}</td></tr>`).join('')}</table>`:'<p>None uploaded.</p>'}
 <h2>General notes</h2><p>${esc(p.notes||'')}</p><div class="signature">Project manager signature</div>`;
 loadThumbs(reportBody);
}

function renderPlanFiles(){
 const p=current();if(!p)return;const filter=document.getElementById('documentFilter');const selected=filter.value;
 const folders=[...new Set((p.files||[]).map(f=>f.folder||'General'))].sort();
 filter.innerHTML='<option value="">All folders</option>'+folders.map(f=>`<option value="${esc(f)}">${esc(f)}</option>`).join('');filter.value=folders.includes(selected)?selected:'';
 const files=(p.files||[]).filter(f=>!filter.value||(f.folder||'General')===filter.value);
 fileList.innerHTML=files.length?files.map(f=>`<div class="fileRow"><div><div class="fname">${esc(f.name)}</div><div class="fmeta">${esc(f.folder||'General')} · ${esc(f.docType)} · ${(f.size/1024).toFixed(0)}KB · ${esc(f.date)}</div>${f.drawingNumber?`<div class="fmeta">${esc(f.drawingNumber)} · Rev ${esc(f.revision)} · ${CIData.isSuperseded(f,p.files)?'Superseded':'Current'}</div>`:''}</div><div class="actions"><button class="secondary small" onclick="viewPlanFile('${f.id}')">View</button><button class="secondary small" onclick="editDocumentDetails('${f.id}')">Folder / revision</button><button class="danger small" onclick="deletePlanFile('${f.id}')">Delete</button></div></div>`).join(''):'<div class="empty">No documents in this folder.</div>';
}

async function addPlanFiles(fileList){
 const docType=document.getElementById('fileType').value;const list=[...fileList];const p=current();
 for(let i=0;i<list.length;i++){
   const f=list[i];toast(`Uploading file ${i+1} of ${list.length}…`,true);
   let blob=f;if(isImage(f)&&f.size>2*1048576)blob=await compressPhoto(f,3200,0.88);
   const mime=blob===f?f.type:blob.type;const id=uid();const path=storagePath(p.cloudId||p.id,id,f.name);
   await uploadCloudFile(path,blob,mime);
   const rec={id,name:f.name,mime,blob,path};await put('planFiles',rec);
   p.files.push({id,name:f.name,mime,docType,size:blob.size,date:today(),path,folder:document.getElementById('documentFolder').value.trim()||'General',drawingNumber:'',revision:''});
   await persist();
 }
 document.getElementById('fileInput').value='';toast(list.length+' file'+(list.length===1?'':'s')+' uploaded');requestPersist();renderPlanFiles();
}
function closeInAppPdf(){return CIPdfViewer.close();}
async function openPdfInApp(blob,title){return CIPdfViewer.open(blob,title);}
async function viewPlanFile(id){
 try{
  let obj=await get('planFiles',id);let blob=obj?.blob||null;
  const p=current();const meta=(p?.files||[]).find(f=>f.id===id)||(p?.hsFiles||[]).find(f=>f.id===id);
  if(!blob){const path=cloudFilePathForId(id);if(path)blob=await cloudBlob(path)}
  if(!blob)return;
  await openPdfInApp(blob,obj?.name||meta?.name||'Plan');
 }catch(e){console.error(e);alert('Could not open this file. Please try again.')}
}
async function deletePlanFile(id){if(!requireRemovalPermission())return;current().files=current().files.filter(f=>f.id!==id);await del('planFiles',id);await persist();renderPlanFiles()}

/* ---------- Urgent to do ---------- */
const URGENT_LABEL={red:'Not started',amber:'Started',green:'Done'};
let urgentFilter='open';
function urgentSorted(p){const o={red:0,amber:1,green:2};return (p.urgent||[]).slice().sort((a,b)=>(o[a.status]-o[b.status])||((b.created||0)-(a.created||0)))}
function filterUrgent(f){urgentFilter=f;renderUrgent()}
function renderUrgent(){
 const p=current();if(!p)return;const all=p.urgent||[];
 const nRed=all.filter(u=>u.status==='red').length,nAmb=all.filter(u=>u.status==='amber').length,nDone=all.filter(u=>u.status==='green').length;
 urgentSummary.innerHTML=all.length?`<span class="badge bad">${nRed} not started</span> <span class="badge warn">${nAmb} started</span> <span class="badge good">${nDone} done</span>`:'';
 const list=urgentSorted(p).filter(u=>urgentFilter==='all'||(urgentFilter==='done'?u.status==='green':u.status!=='green'));
 urgentItems.innerHTML=list.length?list.map(u=>`<div class="item ${u.status}">
 <div class="row"><div style="flex:1;min-width:0"><div class="title">${esc(URGENT_LABEL[u.status])}</div><div class="muted">Raised ${esc(u.raised||'')}${u.status==='green'&&u.doneDate?' • done '+esc(u.doneDate):''}</div></div>
 <div class="statusBtns">
 <button class="statusBtn sRed ${u.status==='red'?'active':''}" title="Not started" aria-label="Not started" onclick="setUrgent('${u.id}','red')"></button>
 <button class="statusBtn sAmber ${u.status==='amber'?'active':''}" title="Started" aria-label="Started" onclick="setUrgent('${u.id}','amber')"></button>
 <button class="statusBtn sGreen ${u.status==='green'?'active':''}" title="Done" aria-label="Done" onclick="setUrgent('${u.id}','green')"></button>
 </div></div>
 <div style="margin-top:10px"><label>Description of works</label><textarea placeholder="What needs doing, where, and why it's urgent…" onchange="updateUrgent('${u.id}','text',this.value)">${esc(u.text||'')}</textarea></div>
 <div style="margin-top:10px"><label>Photos</label><input type="file" accept="image/*" multiple onchange="addUrgentPhotos('${u.id}',this.files);this.value=''"><div class="photos">${(u.photos||[]).map(ph=>`<span class="photoWrap"><img data-pid="${ph.id}" alt="Job photo" onclick="openViewer('urgent','${u.id}','${ph.id}')"><button class="photoDel" onclick="removeUrgentPhoto('${u.id}','${ph.id}')">×</button></span>`).join('')}</div></div>
 <div class="actions" style="margin-top:10px"><button class="danger small" onclick="delUrgent('${u.id}')">Delete job</button></div>
 </div>`).join(''):`<div class="empty">${all.length?'Nothing here.':'No urgent jobs. Use "+ Add job".'}</div>`;
 loadThumbs(urgentItems);
}
async function addUrgent(){current().urgent.unshift({id:uid(),text:'',status:'red',raised:today(),doneDate:'',created:Date.now(),photos:[]});await persist();if(urgentFilter==='done')urgentFilter='open';renderUrgent();const t=urgentItems.querySelector('textarea');if(t)t.focus()}
async function updateUrgent(id,k,v){const u=current().urgent.find(x=>x.id===id);if(!u)return;u[k]=v;await persist()}
async function setUrgent(id,status){const u=current().urgent.find(x=>x.id===id);if(!u)return;u.status=status;u.doneDate=status==='green'?(u.doneDate||today()):'';await persist();renderUrgent()}
async function delUrgent(id){if(!requireRemovalPermission())return;if(!confirm('Delete this job and its photos?'))return;const u=current().urgent.find(x=>x.id===id);for(const ph of (u&&u.photos)||[]){await del('photos',ph.id);dropThumb(ph.id)}current().urgent=current().urgent.filter(x=>x.id!==id);await persist();renderUrgent()}
async function addUrgentPhotos(id,files){
 const list=[...files];
 for(let i=0;i<list.length;i++){
   toast(`Saving photo ${i+1} of ${list.length}…`,true);
   const ph=await storeImage(list[i]);
   const u=current().urgent.find(x=>x.id===id);if(!u)break;if(!u.photos)u.photos=[];
   u.photos.push({id:ph.id,name:ph.name,path:ph.path});await persist();
 }
 toast(list.length+' photo'+(list.length===1?'':'s')+' saved');renderUrgent();
}
async function removeUrgentPhoto(uId,photoId,noConfirm){if(!requireRemovalPermission())return;if(!noConfirm&&!confirm('Delete this photo?'))return;const u=current().urgent.find(x=>x.id===uId);u.photos=u.photos.filter(x=>x.id!==photoId);await del('photos',photoId);dropThumb(photoId);await persist();renderUrgent()}

/* ---------- Health & Safety ---------- */
const PPE_DEFAULTS=['Steel toe-capped boots','High-vis','Gloves','Masks / dust protection','Full dust suits','Ear protection','Eye protection','Hard hat','First aid kit'];
function defaultPPE(){return PPE_DEFAULTS.map(item=>({id:uid(),item,status:'green',reportedBy:'',reportedDate:'',notes:'',replacedDate:''}))}
function renderHS(){
 const p=current();if(!p)return;const ppe=p.ppe||[];const bad=ppe.filter(x=>x.status==='red').length;
 ppeSummary.innerHTML=bad?`<span class="badge bad">${bad} item${bad===1?' needs':'s need'} replacing</span>`:'<span class="badge good">All PPE OK</span>';
 ppeItems.innerHTML=ppe.length?ppe.map(x=>`<div class="item ${x.status==='red'?'red':'green'}">
 <div class="row"><div style="flex:1;min-width:0"><div class="title">${esc(x.item)}</div><div class="muted">${x.status==='red'?'Lost / damaged'+(x.reportedDate?' • reported '+esc(x.reportedDate):''):'OK'+(x.replacedDate?' • replaced '+esc(x.replacedDate):'')}</div></div>
 <div class="statusBtns"><button class="statusBtn sRed ${x.status==='red'?'active':''}" title="Lost / damaged" aria-label="Lost or damaged" onclick="setPPE('${x.id}','red')"></button><button class="statusBtn sGreen ${x.status!=='red'?'active':''}" title="OK" aria-label="OK" onclick="setPPE('${x.id}','green')"></button></div></div>
 ${x.status==='red'?`<div class="grid" style="margin-top:10px"><div><label>Reported by</label><input value="${esc(x.reportedBy||'')}" placeholder="Name" onchange="updatePPE('${x.id}','reportedBy',this.value)"></div><div><label>What's lost / damaged? (size, quantity)</label><input value="${esc(x.notes||'')}" placeholder="e.g. Size 10 boots, sole split" onchange="updatePPE('${x.id}','notes',this.value)"></div></div>`:''}
 <div class="actions" style="margin-top:8px"><button class="danger small" onclick="delPPE('${x.id}')">Remove item</button></div>
 </div>`).join(''):'<div class="empty">No PPE items. Use "+ Add item".</div>';
 hsFileList.innerHTML=(p.hsFiles||[]).length?p.hsFiles.map(f=>`<div class="fileRow"><div><div class="fname">${esc(f.name)}</div><div class="fmeta">${esc(f.docType)} • ${(f.size/1024).toFixed(0)}KB • added ${esc(f.date)}</div></div><div class="actions"><button class="secondary small" onclick="viewPlanFile('${f.id}')">View</button><button class="danger small" onclick="deleteHSFile('${f.id}')">Delete</button></div></div>`).join(''):'<div class="empty">No documents uploaded yet.</div>';
}
async function setPPE(id,status){const x=current().ppe.find(y=>y.id===id);if(!x||x.status===status)return;x.status=status;if(status==='red'){x.reportedDate=today();x.replacedDate=''}else{x.replacedDate=today();x.reportedBy='';x.notes='';x.reportedDate=''}await persist();renderHS()}
async function updatePPE(id,k,v){const x=current().ppe.find(y=>y.id===id);if(!x)return;x[k]=v;await persist()}
async function addPPE(){const n=prompt('PPE / safety item');if(!n)return;current().ppe.push({id:uid(),item:n.trim(),status:'green',reportedBy:'',reportedDate:'',notes:'',replacedDate:''});await persist();renderHS()}
async function delPPE(id){if(!requireRemovalPermission())return;if(!confirm('Remove this item from the PPE list?'))return;current().ppe=current().ppe.filter(x=>x.id!==id);await persist();renderHS()}
async function addHSFiles(fileList){
 const docType=document.getElementById('hsType').value;const list=[...fileList];const p=current();
 for(let i=0;i<list.length;i++){
   const f=list[i];toast(`Uploading file ${i+1} of ${list.length}…`,true);
   let blob=f;if(isImage(f)&&f.size>2*1048576)blob=await compressPhoto(f,3200,0.88);
   const mime=blob===f?f.type:blob.type;const id=uid();const path=storagePath(p.cloudId||p.id,id,f.name);
   await uploadCloudFile(path,blob,mime);
   const rec={id,name:f.name,mime,blob,path};await put('planFiles',rec);
   p.hsFiles.push({id,name:f.name,mime,docType,size:blob.size,date:today(),path});
   await persist();
 }
 document.getElementById('hsInput').value='';toast(list.length+' file'+(list.length===1?'':'s')+' uploaded');requestPersist();renderHS();
}
async function deleteHSFile(id){if(!requireRemovalPermission())return;if(!confirm('Delete this document?'))return;current().hsFiles=current().hsFiles.filter(f=>f.id!==id);await del('planFiles',id);await persist();renderHS()}

async function exportBackup(onlyCurrent){
 try{
 const all=onlyCurrent?[await get('projects',currentId)].filter(Boolean):await getAll('projects');if(!all.length)return;
 const payload=await CIData.buildBackup(all,get,blobToData);
 downloadFile(new File([JSON.stringify(payload)],'constructiq-development-backup-'+today()+'.json',{type:'application/json'}));
 toast('Complete backup exported');
 }catch(e){alert('Backup not exported: '+e.message);}
}

async function restoreBackup(file){
 if(!file)return;
 try{
 const payload=JSON.parse(await file.text());CIData.validateBackup(payload);
 if(CI_CONFIG.cloudEnabled){
  if(!confirm('Import every project as a separate restored copy? Existing shared projects will be preserved.'))return;
  const copies=[],records=[],uploads=[];
  for(const original of payload.projects){
   const copy=structuredClone(original);copy.id=uid();copy.name=(copy.name||'Project')+' — restored copy';delete copy.cloudId;delete copy._localRevision;delete copy._archived;
   for(const [store,entries] of Object.entries(CIData.references([copy])))for(const [oldId,meta] of entries){
    const source=payload[store][oldId];const response=await fetch(source.data);if(!response.ok)throw new Error('Invalid attachment');const blob=await response.blob();const newId=uid();const path=storagePath(copy.id,newId,source.name||meta.name||oldId);
    // Replace every occurrence of a shared attachment identity inside this copy.
    function update(value){if(!value||typeof value!=='object')return;if(value.id===oldId){value.id=newId;value.path=path;delete value.data;}for(const child of Object.values(value))if(child&&typeof child==='object')update(child);}update(copy);
    records.push({store,record:{id:newId,name:source.name,mime:source.mime,type:source.type,blob,path}});uploads.push({id:path,blob,mime:source.mime||source.type||blob.type});
   }
   migrateProject(copy);copies.push(copy);
  }
  await offlineEngine.importCopies(copies,records,uploads);projects=(await getAll('projects')).filter(p=>!p._archived);currentId=copies[0].id;renderAll();offlineEngine.flush().catch(console.error);toast('Restored copies saved; shared originals preserved');return;
 }

 const staged=[];
 for(const store of ['photos','planFiles','changeFiles'])for(const [id,item] of Object.entries(payload[store]||{})){
 const response=await fetch(item.data);if(!response.ok)throw new Error('Invalid attachment');
 const blob=await response.blob();staged.push({store,record:{id,name:item.name,mime:item.mime,type:item.type,blob}});
 }
 if(!confirm('Import into the isolated development workspace? Matching test project IDs will be replaced. Live projects are not connected.'))return;
 const transaction=db.transaction(['projects','photos','planFiles','changeFiles'],'readwrite');
 const completed=new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error||new Error('Import cancelled'));transaction.onerror=()=>reject(transaction.error);});
 for(const p of payload.projects){migrateProject(p);transaction.objectStore('projects').put(p);}
 for(const item of staged)transaction.objectStore(item.store).put(item.record);
 await completed;projects=await getAll('projects');currentId=payload.projects[0]?.id||projects[0]?.id;
 for(const id of thumbUrls.keys())dropThumb(id);
 localStorage.setItem(selectionKey(),currentId||'');renderAll();toast('Backup imported into development');
 }catch(e){alert('Import failed: '+e.message);}
}

function renderAll(){
 document.getElementById('appArea').classList.toggle('hidden',!current());
 renderHeader();renderPicker();if(!current())return;fillDetails();updateStats();renderChecklist();renderMaterials();renderDiary();renderIssues();renderBC();renderHS();renderUrgent();renderReport();renderPlanFiles();if(typeof renderActivity==='function')renderActivity()
}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;installBtn.style.display='inline-block'});
async function installApp(){if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;installBtn.style.display='none'}
if('serviceWorker' in navigator && location.protocol.startsWith('http'))navigator.serviceWorker.register('sw.js').catch(e=>console.warn('Offline app cache unavailable',e));
document.getElementById('loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter')signIn()});
init().catch(e=>{document.getElementById('authErr').textContent='Could not open device storage: '+e.message;});
