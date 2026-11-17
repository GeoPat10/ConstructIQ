/* Explicitly configured cloud adapter; the preview never constructs this. */
(function(root){
 function create({url,publishableKey,getToken,toProject}){
  const request=async(path,options={})=>{const token=await getToken();if(!token)throw Object.assign(new Error('Sign in required'),{status:401});const response=await fetch(url+path,{...options,headers:{apikey:publishableKey,Authorization:'Bearer '+token,...options.headers},signal:AbortSignal.timeout(12000)});if(!response.ok)throw Object.assign(new Error('Cloud request failed'),{status:response.status});return response;};
  return {
   toProject,
   async commit(operation){const response=await request('/rest/v1/rpc/ci_commit_offline_project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_operation_id:operation.operationId,p_project_key:operation.projectId,p_expected:operation.expected,p_snapshot:operation.snapshot})});return response.json();},
   async upload(path,blob,mime){
    await request('/rest/v1/rpc/ci_prepare_upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_path:path})});
    const encoded=path.split('/').map(encodeURIComponent).join('/');
    try{await request('/storage/v1/object/project-files/'+encoded,{method:'POST',headers:{'Content-Type':mime||'application/octet-stream','x-upsert':'false'},body:blob});}
    catch(error){if(![400,409].includes(error.status))throw error;const existing=await (await request('/storage/v1/object/authenticated/project-files/'+encoded)).blob();const hash=async b=>new Uint8Array(await crypto.subtle.digest('SHA-256',await b.arrayBuffer()));const a=await hash(blob),b=await hash(existing);if(a.length!==b.length||a.some((x,i)=>x!==b[i]))throw new Error('Remote attachment differs. Local file was preserved.');}
   },
   async download(path){return (await request('/storage/v1/object/authenticated/project-files/'+path.split('/').map(encodeURIComponent).join('/'))).blob();}
  };
 }
 root.CISyncAdapter={create};if(typeof module!=='undefined')module.exports=root.CISyncAdapter;
})(typeof globalThis!=='undefined'?globalThis:this);
