/* Durable local saves and an idempotent outbox. No network runs without an explicit adapter. */
(function(root){
 const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
 const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('Transaction cancelled'));tx.onerror=()=>reject(tx.error);});
 const clean=p=>{const value=structuredClone(p);delete value._localRevision;return value;};
 const paths=value=>{const result=new Set();function visit(x){if(!x||typeof x!=='object')return;if(typeof x.path==='string'&&x.path)result.add(x.path);for(const child of Object.values(x))if(child&&typeof child==='object')visit(child);}visit(value);return [...result];};
 class LocalConflict extends Error{constructor(){super('This project changed in another tab. Your edit has not overwritten it. Save a separate copy or reload the latest version.');this.name='LocalConflict';}}
 function create(db,{adapter=null,onStatus=()=>{},isOnline=()=>root.navigator?.onLine!==false}={}){
  let flushing=null;const owner=crypto.randomUUID();
  async function read(store,id){return request(db.transaction(store).objectStore(store).get(id));}
  async function all(store){return request(db.transaction(store).objectStore(store).getAll());}
  async function write(store,value){const tx=db.transaction(store,'readwrite');const done=complete(tx);tx.objectStore(store).put(value);await done;}
  async function save(project){
   const snapshot=structuredClone(project);const tx=db.transaction(['projects','outbox'],'readwrite');const done=complete(tx);const store=tx.objectStore('projects');
   const existing=await request(store.get(snapshot.id));
   if((existing?._localRevision||0)!==(snapshot._localRevision||0)){tx.abort();await done.catch(()=>{});throw new LocalConflict();}
   snapshot._localRevision=(existing?._localRevision||0)+1;store.put(snapshot);
   if(adapter)tx.objectStore('outbox').put({id:crypto.randomUUID(),projectId:snapshot.id,revision:snapshot._localRevision,snapshot:clean(snapshot),status:'pending',createdAt:Date.now()});
   await done;project._localRevision=snapshot._localRevision;onStatus(adapter?'pending':'local');return snapshot;
  }
  async function importCopies(copies,records,uploads){
   const stores=['projects','outbox','uploads','photos','planFiles','changeFiles'];const tx=db.transaction(stores,'readwrite');const done=complete(tx);
   for(const p of copies){if(await request(tx.objectStore('projects').get(p.id))){tx.abort();await done.catch(()=>{});throw new Error('Import identity already exists');}tx.objectStore('projects').put({...p,_localRevision:1});if(adapter)tx.objectStore('outbox').put({id:crypto.randomUUID(),projectId:p.id,revision:1,snapshot:clean(p),status:'pending',createdAt:Date.now()});}
   for(const item of records)tx.objectStore(item.store).put(item.record);
   if(adapter)for(const upload of uploads)tx.objectStore('uploads').put({...upload,status:'pending'});
   await done;onStatus(adapter?'pending':'local');
  }
  async function stageUpload(path,blob,mime){if(!adapter)return;await write('uploads',{id:path,blob,mime,status:'pending'});}
  async function list(){return all('outbox');}
  async function lease(acquire){
   const tx=db.transaction('syncState','readwrite');const done=complete(tx);const store=tx.objectStore('syncState');const old=await request(store.get('__lease'));
   if(acquire&&old?.until>Date.now()&&old.owner!==owner){await done;return false;}
   if(acquire)store.put({projectId:'__lease',owner,until:Date.now()+60000});else if(old?.owner===owner)store.delete('__lease');await done;return true;
  }
  async function process(){
   if(!adapter||!isOnline())return {offline:!isOnline()};if(!await lease(true))return {busy:true};
   try{
    const queued=(await list()).sort((a,b)=>a.createdAt-b.createdAt||a.revision-b.revision);const blocked=new Set();let sent=0;
    for(const item of queued){
     if(!isOnline())break;if(['conflict','rejected'].includes(item.status)){blocked.add(item.projectId);continue;}if(blocked.has(item.projectId))continue;
     await lease(true);onStatus('syncing');
     try{
      for(const path of paths(item.snapshot)){const upload=await read('uploads',path);if(upload?.status==='pending'){await adapter.upload(path,upload.blob,upload.mime);await write('uploads',{id:path,status:'uploaded'});}}
      if(!Object.hasOwn(item,'expected')){item.expected=(await read('syncState',item.projectId))?.base??null;await write('outbox',item);}
      const result=await adapter.commit({operationId:item.id,projectId:item.projectId,expected:item.expected,snapshot:item.snapshot});
      if(result.kind==='conflict'){
       await write('outbox',{...item,status:'conflict',remote:result.remote});blocked.add(item.projectId);onStatus('conflict');continue;
      }
      if(result.kind!=='ok')throw new Error('Invalid sync response');
      const tx=db.transaction(['outbox','syncState'],'readwrite');const done=complete(tx);tx.objectStore('syncState').put({projectId:item.projectId,base:result.base});tx.objectStore('outbox').delete(item.id);await done;sent++;
     }catch(error){if(error.status===403){await write('outbox',{...item,status:'rejected'});onStatus('permissions');}else onStatus(error.status===401?'session':'retry');break;}
    }
    if(!(await list()).length)onStatus('synced');return {sent,conflicts:blocked.size};
   }finally{await lease(false);}
  }
  function flush(){if(flushing)return flushing;flushing=process().finally(()=>{flushing=null;});return flushing;}
  async function applyRemote(project,base){
   const tx=db.transaction(['projects','outbox','syncState'],'readwrite');const done=complete(tx);const queued=await request(tx.objectStore('outbox').getAll());
   if(queued.some(item=>item.projectId===project.id)){await done;return false;}
   const old=await request(tx.objectStore('projects').get(project.id));tx.objectStore('projects').put({...project,_localRevision:(old?._localRevision||0)+1});tx.objectStore('syncState').put({projectId:project.id,base});await done;return true;
  }
  // Keep the local edit as a separate project. Remote changes are never discarded automatically.
  async function resolveAsCopy(projectId){
   const queued=(await list()).filter(item=>item.projectId===projectId).sort((a,b)=>a.revision-b.revision);const conflict=queued.find(item=>item.status==='conflict');if(!conflict)throw new Error('No conflict to resolve');
   const latest=queued.at(-1).snapshot;const copy={...structuredClone(latest),id:crypto.randomUUID(),name:(latest.name||'Project')+' — offline copy'};delete copy.cloudId;delete copy._localRevision;
   const tx=db.transaction(['projects','outbox','syncState'],'readwrite');const done=complete(tx);const previous=await request(tx.objectStore('projects').get(projectId));for(const item of queued)tx.objectStore('outbox').delete(item.id);
   if(conflict.remote){const remote=adapter.toProject?adapter.toProject(conflict.remote):conflict.remote;tx.objectStore('projects').put({...remote,id:projectId,_localRevision:(previous?._localRevision||0)+1});tx.objectStore('syncState').put({projectId,base:conflict.remote});}else{tx.objectStore('projects').delete(projectId);tx.objectStore('syncState').delete(projectId);}
   tx.objectStore('projects').put({...copy,_localRevision:1});tx.objectStore('outbox').put({id:crypto.randomUUID(),projectId:copy.id,revision:1,snapshot:copy,status:'pending',createdAt:Date.now()});await done;return copy;
  }
  async function downloadFiles(project,getReferences){
   const refs=getReferences([project]);let saved=0,missing=0;
   for(const [store,entries] of Object.entries(refs))for(const [id,metadata] of entries){const current=await read(store,id);if(current?.blob){saved++;continue;}if(!adapter||!metadata.path){missing++;continue;}try{const blob=await adapter.download(metadata.path);await write(store,{id,name:metadata.name,mime:metadata.mime,type:blob.type,blob,path:metadata.path});saved++;}catch(error){missing++;}}
   return {saved,missing};
  }
  return {save,importCopies,stageUpload,list,flush,applyRemote,resolveAsCopy,downloadFiles,read,adapter};
 }
 root.CIOffline={create,LocalConflict,paths};if(typeof module!=='undefined')module.exports=root.CIOffline;
})(typeof globalThis!=='undefined'?globalThis:this);
