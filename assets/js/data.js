/* Pure data operations, shared by the browser and the regression tests. */
(function(root){
 const sections={name:'Project name',manager:'Project manager',address:'Site address',ref:'Project reference',start:'Start date',target:'Target date',notes:'Project notes',checklist:'Checklist',materials:'Materials',diary:'Variations',issues:'Snagging',files:'Documents',bcPhotos:'Building Control photos',hsFiles:'Safety documents',ppe:'Safety equipment',urgent:'Urgent tasks'};
 function references(projects){
  const refs={photos:new Map(),planFiles:new Map(),changeFiles:new Map()};
  for(const p of projects){
   for(const ph of p.bcPhotos||[])refs.photos.set(ph.id,ph);
   for(const item of [...(p.issues||[]),...(p.urgent||[])])for(const ph of item.photos||[])refs.photos.set(ph.id,ph);
   for(const f of [...(p.files||[]),...(p.hsFiles||[])])refs.planFiles.set(f.id,f);
   for(const d of p.diary||[])for(const f of d.files||[])refs.changeFiles.set(f.id,f);
  }
  return refs;
 }
 async function buildBackup(projects,get,encode){
  const payload={app:'Project Manager Site App',version:5,environment:'development',exported:new Date().toISOString(),projects,photos:{},planFiles:{},changeFiles:{}};
  for(const [store,entries] of Object.entries(references(projects))){
   for(const [id,meta] of entries){
    const record=await get(store,id);
    if(!record?.blob){
     if(store==='photos'&&/^data:[^,]*;base64,/.test(meta.data||'')){payload[store][id]={name:meta.name,type:'image/jpeg',data:meta.data};continue;}
     throw new Error('Missing attachment: '+(meta.name||id)+'. Import or download the complete original file first.');
    }
    payload[store][id]={name:record.name,type:record.type,mime:record.mime,data:await encode(record.blob)};
   }
  }
  return payload;
 }
 function validateBackup(payload){
  if(!payload||payload.app!=='Project Manager Site App'||!Array.isArray(payload.projects)||!payload.projects.length)throw new Error('Not a supported ConstructIQ backup');
  const seen=new Set();
  function checkIds(value){
   if(!value||typeof value!=='object')return;
   for(const [key,item] of Object.entries(value)){
    if(['__proto__','prototype','constructor'].includes(key))throw new Error('Unsupported backup field');
    if(key==='id'&&(typeof item!=='string'||!/^[-a-zA-Z0-9_]{1,150}$/.test(item)))throw new Error('Invalid record ID');
    if(item&&typeof item==='object')checkIds(item);
   }
  }
  for(const p of payload.projects){
   if(!p||typeof p.id!=='string'||seen.has(p.id))throw new Error('Missing or duplicate project ID');seen.add(p.id);
   for(const field of ['checklist','materials','diary','issues','files','bcPhotos','hsFiles','ppe','urgent','activity'])if(p[field]!==undefined&&!Array.isArray(p[field]))throw new Error('Invalid '+field+' data');
   for(const field of ['checklist','materials','diary','issues'])if(!Array.isArray(p[field]))throw new Error('Missing '+field+' data');
   checkIds(p);
  }
  for(const [store,entries] of Object.entries(references(payload.projects))){
   if(!payload[store]||typeof payload[store]!=='object'||Array.isArray(payload[store]))throw new Error('Missing '+store+' attachments');
   for(const id of entries.keys())if(!payload[store][id])throw new Error('Incomplete backup: missing attachment '+id);
  }
  for(const store of ['photos','planFiles','changeFiles'])for(const [id,item] of Object.entries(payload[store]||{})){
   if(!/^[-a-zA-Z0-9_]{1,150}$/.test(id)||!item||!/^data:[a-zA-Z0-9.+\-/]*;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data||''))throw new Error('Invalid attachment data');
  }
  return true;
 }
 function nextActivity(previous,project,actor){
  const history=Array.isArray(previous?.activity)?previous.activity:[];
  const changed=Object.entries(sections).filter(([key])=>JSON.stringify(previous?.[key])!==JSON.stringify(project[key])).map(([,label])=>label);
  if(!changed.length)return history;
  return [...history,{id:(root.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2)),at:new Date().toISOString(),actor,summary:previous?'Updated '+changed.join(', '):'Project created',sections:changed}];
 }
 function isSuperseded(file,files){
  if(!file.drawingNumber)return false;
  const versions=files.filter(f=>f.drawingNumber===file.drawingNumber);
  return versions.indexOf(file)!==versions.length-1;
 }
 const api={references,buildBackup,validateBackup,nextActivity,isSuperseded};root.CIData=api;
 if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
