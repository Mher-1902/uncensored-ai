// An editable account display preference, never legal consent or authorization.
export const WELCOME_VERSION='2026-10-21';
export const WELCOME_FIELD='offscript_welcome';
export type WelcomeUser={id:string;user_metadata?:Record<string,unknown>};
export function hasSeenWelcome(user:WelcomeUser){
  const marker=user.user_metadata?.[WELCOME_FIELD];
  if(!marker||typeof marker!=='object'||Array.isArray(marker))return false;
  const value=marker as {version?:unknown;forUser?:unknown};
  return Boolean(user.id)&&value.version===WELCOME_VERSION&&value.forUser===user.id;
}
type PreferenceAuth={
  getSession:()=>Promise<{data:{session:{user:WelcomeUser;access_token:string}|null};error:unknown}>;
};
type PreferenceConfig={url:string;publishableKey:string};
function accountEndpoint(config:PreferenceConfig){
  const origin=new URL(config.url);
  if(origin.origin!==config.url||origin.protocol!=='https:'||!/^[a-z0-9]+\.supabase\.co$/.test(origin.hostname)||!/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(config.publishableKey))throw Error('Invalid account configuration');
  return new URL('/auth/v1/user',origin);
}
function options(config:PreferenceConfig,token:string):RequestInit{
  if(typeof token!=='string'||!token)throw Error('Missing session');
  return {headers:{apikey:config.publishableKey,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:AbortSignal.timeout(10000)};
}
export async function welcomeNeeded(session:{user:WelcomeUser;access_token:string},config:PreferenceConfig,request:typeof fetch=fetch):Promise<boolean>{
  try{
    if(!session.user.id||hasSeenWelcome(session.user))return false;
    // Restored SDK sessions can have stale metadata after a previous direct PUT.
    // Only show this optional welcome when the original account's current data
    // confirms it is needed. Network failure must not make the notice reappear.
    const response=await request(accountEndpoint(config),{...options(config,session.access_token),method:'GET'});
    if(!response.ok)return false;
    const current=await response.json() as WelcomeUser;
    return Boolean(current&&current.id===session.user.id&&!hasSeenWelcome(current));
  }catch{return false;}
}
export async function rememberWelcome(auth:PreferenceAuth,expectedUser:string,config:PreferenceConfig,request:typeof fetch=fetch):Promise<boolean>{
  try{
    if(!expectedUser)return false;
    const endpoint=accountEndpoint(config);
    const {data,error}=await auth.getSession();
    if(error||data.session?.user.id!==expectedUser)return false;
    if(hasSeenWelcome(data.session.user))return true;
    const token=data.session.access_token;
    if(typeof token!=='string'||!token)return false;
    // Pin credentials to the session that dismissed the welcome. The SDK's
    // updateUser() would read its mutable session again and could update a newly
    // signed-in account instead. Never restore the captured session into the SDK.
    const response=await request(endpoint,{
      ...options(config,token),method:'PUT',
      body:JSON.stringify({data:{[WELCOME_FIELD]:{version:WELCOME_VERSION,forUser:expectedUser}}}),
    });
    if(!response.ok)return false;
    const saved=await response.json() as WelcomeUser;
    return Boolean(saved&&saved.id===expectedUser&&hasSeenWelcome(saved));
  }catch{return false;} // Hide for this page even if the preference cannot sync.
}
