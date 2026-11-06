import {SessionExpiredError} from './session.ts';

export const ACCOUNT_IDLE_MS=30*24*60*60*1000;
export const ACCOUNT_ACTIVITY_FLUSH_MS=60*1000;
const SIGNIN_INTENT_MS=10*60*1000;
const EMAIL_INTENT_MS=60*60*1000;
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type SessionLock=<T>(name:string,timeout:number,work:()=>Promise<T>)=>Promise<T>;
type Binding={userId:string;sessionId:string};
type Active=Binding&{v:1;state:'active';epoch:string;lastActivityAt:number;session:string};
type Inactive={v:1;state:'signed_out';epoch:string;previousSessionId?:string};
type Envelope=Active|Inactive;
type Intent={v:1;id:string;at:number;baseEpoch:string|null;purpose?:'email';previousSessionId?:string};
export type SessionLease=Binding&{epoch:string};
type Options={url:string;persistent?:Store;temporary?:Store;sharedLock?:SessionLock;now?:()=>number;id?:()=>string;onExpired?:()=>void};
const validTime=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128;

function memoryStore():Store {
  const values=new Map<string,string>();
  return {getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value)},removeItem:key=>{values.delete(key)}};
}
function usable(store:Store|undefined,key:string){
  if(!store)return false;
  try {const previous=store.getItem(key);store.setItem(key,'1');const written=store.getItem(key)==='1';if(previous===null)store.removeItem(key);else store.setItem(key,previous);return written;}catch{return false;}
}
function binding(raw:string):Binding|null {
  try {
    if(raw.length>1024*1024)return null;
    const value=JSON.parse(raw);
    if(!identifier(value?.user?.id)||typeof value.access_token!=='string')return null;
    const payload=value.access_token.split('.')[1];
    if(!payload)return null;
    const claims=JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/')));
    if(!identifier(claims.session_id)||claims.sub!==value.user.id)return null;
    return {userId:value.user.id,sessionId:claims.session_id};
  }catch{return null;}
}
function envelope(raw:string|null):Envelope|null {
  try {
    if(!raw||raw.length>1024*1024+4096)return null;
    const value=JSON.parse(raw);
    if(value?.v!==1||!identifier(value.epoch))return null;
    if(value.state==='signed_out')return {v:1,state:'signed_out',epoch:value.epoch,...(identifier(value.previousSessionId)?{previousSessionId:value.previousSessionId}:{})};
    if(value.state!=='active'||!validTime(value.lastActivityAt)||typeof value.session!=='string')return null;
    const owner=binding(value.session);
    if(!owner||owner.userId!==value.userId||owner.sessionId!==value.sessionId)return null;
    return {v:1,state:'active',epoch:value.epoch,lastActivityAt:value.lastActivityAt,session:value.session,...owner};
  }catch{return null;}
}

// The custom SDK adapter stores one atomic envelope per project: authentication
// plus its real-activity timestamp. PKCE, draft recovery and unrelated SDK keys
// remain tab-scoped. Token refresh is never a source of user activity.
export function createAccountPersistence(options:Options){
  const url=new URL(options.url);
  if(url.origin!==options.url||url.protocol!=='https:'||!/^[a-z0-9]+\.supabase\.co$/.test(url.hostname))throw Error('Invalid account configuration.');
  const project=url.hostname.split('.')[0],storageKey=`sb-${project}-auth-token`;
  const intentKey=`offscript.signin-intent.v1:${project}`;
  const activityKey=`${storageKey}-activity`;
  const now=options.now??Date.now,id=options.id??(()=>crypto.randomUUID());
  const memory=memoryStore(),probe=`offscript.auth-probe.v1:${project}:${id()}`;
  const temporaryAvailable=usable(options.temporary,probe);
  const temporary=temporaryAvailable?options.temporary!:memory;
  // Durable cross-tab sessions require the same Web Lock used by the SDK.
  // Without it, safely retain tab/memory-only behavior rather than allowing a
  // late refresh in another tab to overwrite a newer account or signed-out state.
  const persistentAvailable=Boolean(options.sharedLock)&&usable(options.persistent,probe);
  const store=persistentAvailable?options.persistent!:temporary;
  const mode=persistentAvailable?'persistent':temporaryAvailable?'tab':'memory';
  let disposed=false,notified:string|null=null,pending:{epoch:string;at:number}|null=null,lastWrite=0;
  let revocation:{previousEpoch:string|null;marker:Inactive}|null=null;
  let localLock:Promise<unknown>=Promise.resolve();
  const lock:SessionLock=options.sharedLock??(async(_name,_timeout,work)=>{
    const previous=localLock;let release!:()=>void;localLock=new Promise<void>(resolve=>{release=resolve});
    await previous.catch(()=>{});try{return await work();}finally{release();}
  });
  const locked=<T,>(work:()=>T|Promise<T>)=>lock(`lock:${storageKey}`,-1,async()=>work());
  const read=()=>{
    let value:Envelope|null=null;try{value=envelope(store.getItem(storageKey));}catch{}
    // A failed durable write must not leave this client able to reuse its old
    // credentials. A genuinely newer envelope from another tab can replace the
    // fence; rereading the old value or an empty key cannot.
    if(revocation){
      if(!value||revocation.previousEpoch===null||value.epoch===revocation.previousEpoch||value.epoch===revocation.marker.epoch)return revocation.marker;
      revocation=null;
    }
    return value;
  };
  const write=(value:Envelope)=>{store.setItem(storageKey,JSON.stringify(value));};
  function notify(epoch:string){if(disposed||notified===epoch)return;notified=epoch;options.onExpired?.();}
  function effectiveLast(value:Active){
    let captured=0;
    try{
      const checkpoint=JSON.parse(store.getItem(activityKey)||'null');
      if(checkpoint?.v===1&&checkpoint.epoch===value.epoch&&checkpoint.userId===value.userId&&checkpoint.sessionId===value.sessionId&&validTime(checkpoint.at))captured=checkpoint.at;
    }catch{}
    return Math.max(value.lastActivityAt,captured,pending?.epoch===value.epoch?pending.at:0);
  }
  function alive(value:Active,time=now()){const last=effectiveLast(value);return validTime(time)&&last<=time&&time-last<ACCOUNT_IDLE_MS;}
  function inactive(value:Envelope|null,announce=true){
    pending=null;
    const previousSessionId=value?.state==='active'?value.sessionId:value?.previousSessionId;
    const marker:Inactive={v:1,state:'signed_out',epoch:id(),...(previousSessionId?{previousSessionId}:{})};
    // Preserve the original fenced epoch across repeated failed sign-outs;
    // replacing it with the virtual marker's epoch would unblock old bytes.
    revocation={previousEpoch:revocation?revocation.previousEpoch:value?.epoch??null,marker};
    let removed=false;
    try{write(marker);removed=true;}
    catch{
      // Deletion can succeed when replacement fails (for example quota or a
      // storage fault). Prefer forgetting credentials over retaining a marker.
      try{store.removeItem(storageKey);removed=true;}catch{}
      if(removed)try{write(marker);}catch{/* The in-memory fence remains. */}
    }
    try{store.removeItem(activityKey);}catch{}
    if(options.temporary!==store)try{options.temporary?.removeItem(storageKey);}catch{/* Only the known legacy account key is touched. */}
    if(value&&announce)notify(value.epoch);
    if(!removed)throw Error('This browser could not remove the saved sign-in. Clear this site’s browser data before leaving a shared device.');
  }
  function current(notifyExpiry=true):Active|null {
    if(disposed)return null;
    const value=read();
    if(value?.state==='active'&&alive(value))return value;
    if(value?.state==='active'&&notifyExpiry){
      notify(value.epoch);
      void locked(()=>{const latest=read();if(latest?.state==='active'&&latest.epoch===value.epoch&&!alive(latest))inactive(latest);}).catch(()=>{});
    }
    return null;
  }
  function intent():Intent|null {
    try {
      const value=JSON.parse(temporary.getItem(intentKey)||'null'),time=now();
      const lifetime=value?.purpose==='email'?EMAIL_INTENT_MS:SIGNIN_INTENT_MS;
      if(value?.v!==1||!identifier(value.id)||!validTime(value.at)||!validTime(time)||value.at>time||time-value.at>=lifetime
        ||(value.baseEpoch!==null&&!identifier(value.baseEpoch))||(value.purpose!==undefined&&value.purpose!=='email')){temporary.removeItem(intentKey);return null;}
      return {v:1,id:value.id,at:value.at,baseEpoch:value.baseEpoch,...(value.purpose==='email'?{purpose:'email' as const}:{}),...(identifier(value.previousSessionId)?{previousSessionId:value.previousSessionId}:{})};
    }catch{return null;}
  }
  function migrateLegacy(){
    // Called by the SDK while holding the shared lock. A tombstone prevents an
    // old tab's pre-migration credentials from undoing a subsequent sign-out.
    let raw:string|null=null;
    try{raw=options.temporary?.getItem(storageKey)??null;}catch{return;}
    const saved=read();
    if(!saved&&raw&&binding(raw)){
      let existing:string|null=null;try{existing=store.getItem(storageKey);}catch{return;}
      if(existing===null||store===options.temporary){
        const owner=binding(raw)!;const time=now();if(!validTime(time))return;
        write({v:1,state:'active',epoch:id(),lastActivityAt:time,session:raw,...owner});
      }
    }
    if(store!==options.temporary)try{options.temporary?.removeItem(storageKey);}catch{/* Preserve other tab keys, including PKCE and the draft. */}
  }
  const storage={
    getItem(key:string):string|null {
      if(key!==storageKey){try{return temporary.getItem(key);}catch{return null;}}
      if(disposed)return null;
      migrateLegacy();const value=read();
      if(value?.state==='active'&&alive(value))return value.session;
      if(value?.state==='active')try{inactive(value);}catch{notify(value.epoch);}
      return null;
    },
    setItem(key:string,raw:string){
      if(key!==storageKey){try{temporary.setItem(key,raw);}catch{/* An OAuth redirect is separately blocked without tab storage. */}return;}
      if(disposed)return;
      const owner=binding(raw);if(!owner)return;
      const attempt=intent(),saved=read();
      try {
        if(attempt&&attempt.baseEpoch===(saved?.epoch??null)&&owner.sessionId!==attempt.previousSessionId){
          write({v:1,state:'active',epoch:attempt.id,lastActivityAt:attempt.at,session:raw,...owner});revocation=null;
          temporary.removeItem(intentKey);store.removeItem(activityKey);pending=null;lastWrite=now();notified=null;return;
        }
        if(saved?.state==='active'&&alive(saved)&&saved.userId===owner.userId&&saved.sessionId===owner.sessionId){
          write({...saved,lastActivityAt:effectiveLast(saved),session:raw});return;
        }
        if(saved?.state==='active'&&!alive(saved))inactive(saved);
      }catch{if(saved)notify(saved.epoch);}
      // No user-initiated sign-in or valid current session: ignore a late SDK
      // refresh. The event callback and token provider also reject its result.
    },
    removeItem(key:string){
      if(key!==storageKey){try{temporary.removeItem(key);}catch{}return;}
      if(disposed)return;
      const saved=read();try{inactive(saved,false);}catch(error){if(saved)notify(saved.epoch);throw error;}
    },
  };
  async function beginSignIn(requireRedirectStorage=false,email=false){
    if(requireRedirectStorage&&!temporaryAvailable)throw Error('Allow browser tab storage to complete provider sign-in. Your draft stays on this page.');
    return locked(()=>{
      if(disposed)throw new SessionExpiredError();
      migrateLegacy();
      let saved=read();
      // Capture the post-expiry epoch so the SDK's later read cannot invalidate
      // a newly deliberate sign-in by expiring the old session in between.
      if(saved?.state==='active'&&!alive(saved)){inactive(saved);saved=read();}
      const attempt:Intent={v:1,id:id(),at:now(),baseEpoch:saved?.epoch??null,...(email?{purpose:'email' as const}:{})};
      if(!validTime(attempt.at))throw new SessionExpiredError();
      if(saved?.state==='active')attempt.previousSessionId=saved.sessionId;
      else if(saved?.previousSessionId)attempt.previousSessionId=saved.previousSessionId;
      temporary.setItem(intentKey,JSON.stringify(attempt));return attempt.id;
    });
  }
  async function cancelSignIn(attemptId?:string){
    await locked(()=>{const attempt=intent();if(attempt&&(!attemptId||attempt.id===attemptId))temporary.removeItem(intentKey);});
  }
  async function touch(){
    return locked(()=>{
      const value=current();if(!value)return false;
      const time=now();pending={epoch:value.epoch,at:Math.max(effectiveLast(value),time)};
      if(time-lastWrite>=ACCOUNT_ACTIVITY_FLUSH_MS){write({...value,lastActivityAt:pending.at});lastWrite=time;pending=null;}
      return true;
    });
  }
  // Flush the captured activity time, never the background timer/pagehide time.
  async function flush(){
    return locked(()=>{
      const value=current();if(!value||pending?.epoch!==value.epoch)return;
      write({...value,lastActivityAt:Math.max(value.lastActivityAt,pending.at)});lastWrite=now();pending=null;
    });
  }
  function flushForPageHide(){
    // This synchronous checkpoint never writes credentials. It is session/epoch
    // bound, so a delayed pagehide from an old tab cannot revive an old account.
    if(disposed||!pending)return;
    const value=read();
    if(value?.state!=='active'||value.epoch!==pending.epoch||!alive(value))return;
    try{store.setItem(activityKey,JSON.stringify({v:1,epoch:value.epoch,userId:value.userId,sessionId:value.sessionId,at:pending.at}));pending=null;}catch{}
  }
  function lease():SessionLease|null {const value=current();return value?{epoch:value.epoch,userId:value.userId,sessionId:value.sessionId}:null;}
  function leaseCurrent(expected:SessionLease){const value=current();return Boolean(value&&value.epoch===expected.epoch&&value.userId===expected.userId&&value.sessionId===expected.sessionId);}
  function accepts(session:{access_token:string;user:{id:string}}|null|undefined){
    if(!session)return false;const value=current(),owner=binding(JSON.stringify(session));
    return Boolean(value&&owner&&owner.userId===value.userId&&owner.sessionId===value.sessionId);
  }
  return {storageKey,intentKey,activityKey,storage,lock,mode,beginSignIn,cancelSignIn,touch,flush,flushForPageHide,lease,leaseCurrent,accepts,isActive:()=>Boolean(current()),
    watches:(key:string|null)=>key===null||key===storageKey||key===activityKey,
    dispose(){disposed=true;pending=null;},
  };
}
export type AccountPersistence=ReturnType<typeof createAccountPersistence>;

// Expiry is an epoch-checked browser-storage operation. Do not issue a generic
// asynchronous SDK signOut here: after waiting for its lock it could revoke a
// different session that completed provider sign-in in the meantime.
export function expireBrowserSessionIfInactive(persistence:Pick<AccountPersistence,'isActive'>,clearUi:()=>void){
  if(persistence.isActive())return false;
  clearUi();return true;
}

type SessionResult={data:{session:{access_token:string;user:{id:string}}|null};error:unknown};
type AuthReader={getSession:()=>Promise<SessionResult>;refreshSession:()=>Promise<SessionResult>};
export function guardedAccountReader(auth:AuthReader,persistence:AccountPersistence):AuthReader {
  const read=async(refresh:boolean)=>{
    const captured=persistence.lease();if(!captured)throw new SessionExpiredError();
    const result=await(refresh?auth.refreshSession():auth.getSession());
    if(!persistence.leaseCurrent(captured)||result.data.session&&!persistence.accepts(result.data.session))throw new SessionExpiredError();
    return result;
  };
  return {getSession:()=>read(false),refreshSession:()=>read(true)};
}

export function browserSessionLock(manager:LockManager):SessionLock {
  return async(name,wait,work)=>{
    const timeoutError=()=>Object.assign(Error('Sign-in storage is busy. Please try again.'),{isAcquireTimeout:true});
    let acquired=false;
    const interrupted=(error:unknown)=>!acquired&&error instanceof Error&&error.name==='AbortError';
    if(wait===0){
      try{return await manager.request(name,{mode:'exclusive',ifAvailable:true},async value=>{if(!value)throw timeoutError();acquired=true;return work();});}
      catch(error){if(interrupted(error))throw timeoutError();throw error;}
    }
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),wait<0?10000:wait);
    try{return await manager.request(name,{mode:'exclusive',signal:controller.signal},async()=>{acquired=true;return work();});}
    catch(error){if((!acquired&&controller.signal.aborted)||interrupted(error))throw timeoutError();throw error;}
    finally{clearTimeout(timer);}
  };
}

export async function supportedBrowserSessionLock(manager:LockManager){
  const lock=browserSessionLock(manager);
  try{await lock('offscript.auth-capability.v1',1000,async()=>{});return lock;}
  catch(error){
    // Some browsers expose the property but deny its use. Keep the existing
    // isolated tab-storage fallback; never use durable storage without a lock.
    if(error instanceof Error&&['SecurityError','NotSupportedError'].includes(error.name))return undefined;
    throw error;
  }
}
