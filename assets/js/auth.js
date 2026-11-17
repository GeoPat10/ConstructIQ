/* Verified identities, rotating refresh tokens and an explicit offline cache window. */
(function(root){
 function create({url,key,storage=root.localStorage,fetcher=root.fetch.bind(root),now=()=>Date.now(),online=()=>root.navigator?.onLine!==false,locks=root.navigator?.locks,storageKey='CI2_SESSION'}){
  let session=null,refreshing=null;
  const read=()=>{try{return JSON.parse(storage.getItem(storageKey)||'null');}catch{return null;}};
  const save=s=>{session=s;storage.setItem(storageKey,JSON.stringify(s));return s;};
  async function request(path,options={}){
   const response=await fetcher(url+path,{...options,headers:{apikey:key,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(12000)});
   if(!response.ok)throw Object.assign(new Error(response.status===401||response.status===400?'Sign in again to reconnect.':'Account service unavailable. Your device data is preserved.'),{status:response.status});
   return response.status===204?null:response.json();
  }
  function fromResponse(data,verifiedAt=now()){
   if(!data.access_token||!data.refresh_token||!/^[-a-f0-9]{36}$/i.test(data.user?.id||''))throw new Error('Invalid account response');
   return {access_token:data.access_token,refresh_token:data.refresh_token,expires_at:Number(data.expires_at)||Math.floor(now()/1000)+Number(data.expires_in||3600),user:{id:data.user.id,email:data.user.email||''},verifiedAt};
  }
  async function refresh(){
   if(refreshing)return refreshing;
   const run=async()=>{
    const latest=read();if(!latest?.refresh_token)throw Object.assign(new Error('Sign in required'),{status:401});
    if(latest.expires_at*1000>now()+60000){session=latest;return session;}
    const data=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:latest.refresh_token})});
    return save(fromResponse(data));
   };
   refreshing=(locks?locks.request('constructiq-refresh-'+storageKey,run):run()).finally(()=>{refreshing=null;});return refreshing;
  }
  async function token(){session=read();if(!session)return null;if(session.expires_at*1000<=now()+60000){if(!online())throw Object.assign(new Error('Offline: changes stay on this device'),{status:0});await refresh();}return session.access_token;}
  async function signIn(email,password){const data=await request('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});return save(fromResponse(data));}
  async function restore(){
   session=read();if(!session?.user?.id)return null;
   if(!online())return now()-session.verifiedAt<=7*86400000?{...session,offline:true}:null;
   try{const access=await token();const user=await request('/auth/v1/user',{headers:{Authorization:'Bearer '+access}});if(user.id!==session.user.id)throw new Error('Account changed');return save({...session,user:{id:user.id,email:user.email||''},verifiedAt:now()});}
   catch(error){if([400,401,403].includes(error.status)){storage.removeItem(storageKey);session=null;}throw error;}
  }
  async function signOut(){const old=read();storage.removeItem(storageKey);session=null;if(old?.access_token&&online())try{await request('/auth/v1/logout?scope=local',{method:'POST',headers:{Authorization:'Bearer '+old.access_token}});}catch{/* Local sign-out remains effective if the network fails. */}}
  return {signIn,restore,token,signOut,current:()=>session};
 }
 root.CIAuth={create};if(typeof module!=='undefined')module.exports=root.CIAuth;
})(typeof globalThis!=='undefined'?globalThis:this);
