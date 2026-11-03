import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountPersistence,guardedAccountReader,expireBrowserSessionIfInactive,ACCOUNT_IDLE_MS,ACCOUNT_ACTIVITY_FLUSH_MS} from '../src/account-persistence.ts';
import {SessionExpiredError} from '../src/session.ts';

const NOW=1793440000000,DAY=24*60*60*1000,URL='https://projectfixture.supabase.co';
const KEY='sb-projectfixture-auth-token';
const USER_A='11111111-1111-4111-8111-111111111111',USER_B='22222222-2222-4222-8222-222222222222';
const SESSION_A='33333333-3333-4333-8333-333333333333',SESSION_B='44444444-4444-4444-8444-444444444444';
function stored(values=[]){
  const data=new Map(values),calls=[];
  const storage={getItem(key){calls.push(['get',key]);return data.get(key)??null;},setItem(key,value){calls.push(['set',key]);data.set(key,value);},removeItem(key){calls.push(['remove',key]);data.delete(key);},clear(){throw Error('Origin-wide clear is forbidden');},key(){throw Error('Storage enumeration is forbidden');}};
  return {data,calls,storage};
}
function sharedLocks(){
  const waiting=new Map();
  return async(name,_timeout,work)=>{const previous=waiting.get(name)||Promise.resolve();let release;waiting.set(name,new Promise(resolve=>{release=resolve;}));await previous.catch(()=>{});try{return await work();}finally{release();}};
}
function session(userId=USER_A,sessionId=SESSION_A,label='first'){
  const payload=Buffer.from(JSON.stringify({sub:userId,session_id:sessionId})).toString('base64url');
  return {access_token:`fixture.${payload}.${label}`,refresh_token:`fixture-${label}`,user:{id:userId}};
}
function fixture({local=stored(),tab=stored(),lock=sharedLocks(),time=NOW,...rest}={}){
  const clock={value:time};let ids=0,expired=0;
  const create=(temporary=tab.storage)=>createAccountPersistence({url:URL,persistent:local.storage,temporary,sharedLock:lock,now:()=>clock.value,id:()=>`fixture-id-${++ids}`,onExpired:()=>{expired++;},...rest});
  const persistence=create();return {local,tab,clock,create,persistence,get expired(){return expired;}};
}
async function signIn(persistence,value=session()){
  await persistence.beginSignIn();persistence.storage.setItem(persistence.storageKey,JSON.stringify(value));assert.equal(persistence.accepts(value),true);return value;
}
const result=value=>({data:{session:value},error:null});

test('the browser session survives a fresh tab but expires after exactly30 idle days',async()=>{
  const f=fixture();const original=await signIn(f.persistence);
  f.clock.value=NOW+29*DAY;const later=f.create(stored().storage);
  assert.deepEqual(JSON.parse(later.storage.getItem(KEY)),original);
  assert.equal(JSON.parse(f.local.data.get(KEY)).lastActivityAt,NOW,'Opening storage is not activity');
  f.clock.value=NOW+ACCOUNT_IDLE_MS;
  assert.equal(later.storage.getItem(KEY),null);assert.equal(later.isActive(),false);
  assert.equal(JSON.parse(f.local.data.get(KEY)).state,'signed_out');
  assert.equal(f.local.data.get(KEY).includes('access_token'),false);
});

test('actual activity rolls the idle window while token refresh does not',async()=>{
  const f=fixture();await signIn(f.persistence);
  f.clock.value=NOW+29*DAY;
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_A,'refresh')));
  assert.equal(JSON.parse(f.local.data.get(KEY)).lastActivityAt,NOW);
  assert.equal(await f.persistence.touch(),true);
  assert.equal(JSON.parse(f.local.data.get(KEY)).lastActivityAt,NOW+29*DAY);
  f.clock.value=NOW+58*DAY;assert.equal(f.persistence.isActive(),true);
  f.clock.value=NOW+59*DAY;assert.equal(f.persistence.isActive(),false);
});

test('returning after expiry cannot revive the session by touching the page',async()=>{
  const f=fixture();await signIn(f.persistence);f.clock.value=NOW+ACCOUNT_IDLE_MS;
  assert.equal(await f.persistence.touch(),false);assert.equal(f.persistence.storage.getItem(KEY),null);
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_A,'late')));
  assert.equal(f.persistence.isActive(),false);assert.ok(f.expired>=1);
});

test('throttled activity flushes its captured time on pagehide, never background time',async()=>{
  const f=fixture();await signIn(f.persistence);
  f.clock.value=NOW+1000;await f.persistence.touch();
  assert.equal(JSON.parse(f.local.data.get(KEY)).lastActivityAt,NOW);
  f.clock.value=NOW+5*60*1000;f.persistence.flushForPageHide();
  assert.equal(JSON.parse(f.local.data.get(f.persistence.activityKey)).at,NOW+1000);
  const reopened=f.create(stored().storage);f.clock.value=NOW+ACCOUNT_IDLE_MS+999;
  assert.equal(reopened.isActive(),true);f.clock.value++;
  assert.equal(reopened.isActive(),false);
});

test('a background flush does not extend activity to the time its timer fired',async()=>{
  const f=fixture();await signIn(f.persistence);f.clock.value=NOW+2000;await f.persistence.touch();
  f.clock.value=NOW+ACCOUNT_ACTIVITY_FLUSH_MS+5000;await f.persistence.flush();
  assert.equal(JSON.parse(f.local.data.get(KEY)).lastActivityAt,NOW+2000);
});

test('explicit signout rejects late refreshes and a new deliberate sign-in gets a new epoch',async()=>{
  const f=fixture();await signIn(f.persistence);const old=f.persistence.lease();
  f.persistence.storage.removeItem(KEY);
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_A,'late')));
  assert.equal(f.persistence.storage.getItem(KEY),null);assert.equal(f.persistence.leaseCurrent(old),false);
  await signIn(f.persistence,session(USER_A,SESSION_B,'new-login'));
  assert.notEqual(f.persistence.lease().epoch,old.epoch);
});

test('an old refresh cannot consume a newly armed sign-in intent',async()=>{
  const f=fixture();await signIn(f.persistence);f.persistence.storage.removeItem(KEY);
  const intent=await f.persistence.beginSignIn();
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_A,'late')));
  assert.equal(f.persistence.isActive(),false);
  assert.equal(JSON.parse(f.tab.data.get(f.persistence.intentKey)).id,intent);
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_B,'new')));
  assert.equal(f.persistence.isActive(),true);assert.equal(f.tab.data.has(f.persistence.intentKey),false);
});

test('cross-tab signout and cleared auth storage invalidate other token leases',async()=>{
  const f=fixture();await signIn(f.persistence);const other=f.create(stored().storage),lease=other.lease();
  f.persistence.storage.removeItem(KEY);assert.equal(other.leaseCurrent(lease),false);assert.equal(other.storage.getItem(KEY),null);
  await signIn(f.persistence,session(USER_A,SESSION_B));const current=other.lease();
  f.local.data.delete(KEY);assert.equal(other.leaseCurrent(current),false);
  other.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_B,'late-cleared')));
  assert.equal(other.storage.getItem(KEY),null);
});

test('an asynchronous token refresh cannot return credentials after idle expiry',async()=>{
  const f=fixture();await signIn(f.persistence);let resolve;
  const auth={getSession:async()=>result(session()),refreshSession:()=>new Promise(done=>{resolve=done;})};
  const reader=guardedAccountReader(auth,f.persistence),pending=reader.refreshSession();
  f.clock.value=NOW+ACCOUNT_IDLE_MS;resolve(result(session(USER_A,SESSION_A,'late')));
  await assert.rejects(pending,SessionExpiredError);
});

test('a replaced account rejects the old in-flight refresh and preserves the new session',async()=>{
  const f=fixture();await signIn(f.persistence);let resolve;
  const reader=guardedAccountReader({getSession:async()=>result(session()),refreshSession:()=>new Promise(done=>{resolve=done;})},f.persistence);
  const pending=reader.refreshSession();f.persistence.storage.removeItem(KEY);
  const replacement=session(USER_B,SESSION_B,'replacement');await signIn(f.persistence,replacement);
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_A,'late')));
  resolve(result(session(USER_A,SESSION_A,'late')));await assert.rejects(pending,SessionExpiredError);
  assert.deepEqual(JSON.parse(f.persistence.storage.getItem(KEY)),replacement);
});

test('legacy migration touches only the known project session and preserves PKCE/draft/notices',()=>{
  const original=session(),draft='draft fixture',pkce='verifier fixture';
  const tab=stored([[KEY,JSON.stringify(original)],[KEY+'-code-verifier',pkce],['offscript.signin-draft.v1',draft],['unrelated','keep']]);
  const local=stored([['offscript.storage-notice.2026-10-21','notice']]);const f=fixture({tab,local});
  assert.deepEqual(JSON.parse(f.persistence.storage.getItem(KEY)),original);
  assert.equal(tab.data.has(KEY),false);assert.equal(tab.data.get(KEY+'-code-verifier'),pkce);
  assert.equal(tab.data.get('offscript.signin-draft.v1'),draft);assert.equal(tab.data.get('unrelated'),'keep');
  assert.equal(local.data.get('offscript.storage-notice.2026-10-21'),'notice');
  assert.equal(f.persistence.storage.getItem(KEY+'-code-verifier'),pkce);
  assert.equal(local.data.has(KEY+'-code-verifier'),false);
});

test('a signout tombstone prevents an old tab from remigrating its legacy credentials',async()=>{
  const f=fixture();await signIn(f.persistence);f.persistence.storage.removeItem(KEY);
  const legacy=stored([[KEY,JSON.stringify(session())],['offscript.signin-draft.v1','keep']]);
  const old=f.create(legacy.storage);assert.equal(old.storage.getItem(KEY),null);
  assert.equal(legacy.data.has(KEY),false);assert.equal(legacy.data.get('offscript.signin-draft.v1'),'keep');
});

test('blocked local storage falls back to tab storage; blocked tab storage blocks OAuth redirect',async()=>{
  const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
  const f=fixture({local:{storage:blocked},tab:stored()});assert.equal(f.persistence.mode,'tab');await signIn(f.persistence);assert.ok(f.persistence.storage.getItem(KEY));
  const memory=fixture({local:{storage:blocked},tab:{storage:blocked}});assert.equal(memory.persistence.mode,'memory');
  await assert.rejects(memory.persistence.beginSignIn(true),/Allow browser tab storage/);
  await signIn(memory.persistence);assert.ok(memory.persistence.storage.getItem(KEY));
});

test('browsers without shared locks retain tab scope instead of unsafe durable refresh races',async()=>{
  const f=fixture({lock:null});assert.equal(f.persistence.mode,'tab');await signIn(f.persistence);
  assert.equal(f.local.data.has(KEY),false);assert.ok(f.tab.data.has(KEY));
});

test('corrupt, future-dated and mismatched session data cannot create a usable session',async()=>{
  const f=fixture();f.persistence.storage.setItem(KEY,'{bad');assert.equal(f.persistence.isActive(),false);
  await signIn(f.persistence);const value=JSON.parse(f.local.data.get(KEY));value.lastActivityAt=NOW+1;f.local.data.set(KEY,JSON.stringify(value));assert.equal(f.persistence.storage.getItem(KEY),null);
  await f.persistence.beginSignIn();const mismatch=session(USER_B,SESSION_B);mismatch.user.id=USER_A;
  f.persistence.storage.setItem(KEY,JSON.stringify(mismatch));assert.equal(f.persistence.isActive(),false);
});

test('sign-in intents expire and cancelling an older attempt does not cancel its replacement',async()=>{
  const f=fixture();const first=await f.persistence.beginSignIn(),second=await f.persistence.beginSignIn();
  await f.persistence.cancelSignIn(first);assert.equal(JSON.parse(f.tab.data.get(f.persistence.intentKey)).id,second);
  f.clock.value=NOW+10*60*1000;f.persistence.storage.setItem(KEY,JSON.stringify(session()));assert.equal(f.persistence.isActive(),false);
  await f.persistence.beginSignIn();await f.persistence.cancelSignIn();f.persistence.storage.setItem(KEY,JSON.stringify(session()));assert.equal(f.persistence.isActive(),false);
});

test('disposing an old client invalidates its in-flight token result without signing out the browser',async()=>{
  const f=fixture();await signIn(f.persistence);let resolve;
  const reader=guardedAccountReader({getSession:()=>new Promise(done=>{resolve=done;}),refreshSession:async()=>result(session())},f.persistence);
  const pending=reader.getSession();f.persistence.dispose();resolve(result(session()));await assert.rejects(pending,SessionExpiredError);
  const current=f.create(stored().storage);assert.equal(current.isActive(),true);
});

test('an explicitly requested email flow can finish later without extending its fixed one-hour eligibility',async()=>{
  const f=fixture();await f.persistence.beginSignIn(false,true);f.clock.value=NOW+20*60*1000;
  f.persistence.storage.setItem(KEY,JSON.stringify(session()));assert.equal(f.persistence.isActive(),true);
  const expired=fixture();await expired.persistence.beginSignIn(false,true);expired.clock.value=NOW+60*60*1000;
  expired.persistence.storage.setItem(KEY,JSON.stringify(session()));assert.equal(expired.persistence.isActive(),false);
});

test('persistence never reads an IP, user-agent, fingerprint, or unrelated storage key',async()=>{
  const f=fixture();await signIn(f.persistence);await f.persistence.touch();f.persistence.flushForPageHide();
  for(const [,key] of [...f.local.calls,...f.tab.calls])assert.ok(key===KEY||key===f.persistence.activityKey||key===f.persistence.intentKey||key.startsWith('offscript.auth-probe.v1:projectfixture:'),key);
  assert.equal(f.persistence.watches(null),true);assert.equal(f.persistence.watches('offscript.signin-draft.v1'),false);
});

test('a queued browser-expiry callback cannot invalidate a replacement sign-in',async()=>{
  const f=fixture();await signIn(f.persistence);const old=f.persistence.lease();let cleared=0;
  f.clock.value=NOW+ACCOUNT_IDLE_MS;
  const deferred=()=>expireBrowserSessionIfInactive(f.persistence,()=>{cleared++;});
  assert.equal(expireBrowserSessionIfInactive(f.persistence,()=>{cleared++;}),true);
  const replacement=session(USER_B,SESSION_B,'replacement');await signIn(f.persistence,replacement);
  const current=f.persistence.lease();
  assert.equal(deferred(),false);assert.equal(cleared,1);
  assert.equal(f.persistence.leaseCurrent(current),true);assert.equal(f.persistence.leaseCurrent(old),false);
  assert.deepEqual(JSON.parse(f.persistence.storage.getItem(KEY)),replacement);
});

test('an OAuth intent started before a later sign-out cannot restore credentials',async()=>{
  const f=fixture();await signIn(f.persistence);const other=f.create(stored().storage);
  await f.persistence.beginSignIn(true);
  const base=JSON.parse(f.tab.data.get(f.persistence.intentKey)).baseEpoch;
  assert.equal(base,f.persistence.lease().epoch);
  other.storage.removeItem(KEY);const tombstone=f.local.data.get(KEY);
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_B,'old-callback')));
  assert.equal(f.persistence.isActive(),false);assert.equal(f.local.data.get(KEY),tombstone);
  const fresh=session(USER_A,SESSION_B,'fresh-callback');await signIn(f.persistence,fresh);
  assert.deepEqual(JSON.parse(f.persistence.storage.getItem(KEY)),fresh);
});

test('an older OAuth callback cannot replace a newer account committed in another tab',async()=>{
  const f=fixture();await signIn(f.persistence);const other=f.create(stored().storage);
  await f.persistence.beginSignIn(true);
  const replacement=session(USER_B,SESSION_B,'other-tab');await signIn(other,replacement);
  const current=other.lease();
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,'55555555-5555-4555-8555-555555555555','stale-callback')));
  assert.equal(other.leaseCurrent(current),true);
  assert.deepEqual(JSON.parse(other.storage.getItem(KEY)),replacement);
});

test('a fresh OAuth intent survives reconstruction while an expired prior session gets a stable new baseline',async()=>{
  const first=fixture();await first.persistence.beginSignIn(true);
  assert.equal(JSON.parse(first.tab.data.get(first.persistence.intentKey)).baseEpoch,null);
  const callback=first.create();callback.storage.setItem(KEY,JSON.stringify(session()));
  assert.equal(callback.isActive(),true);
  const f=fixture();await signIn(f.persistence);f.clock.value=NOW+ACCOUNT_IDLE_MS;
  await f.persistence.beginSignIn(true);
  const marker=JSON.parse(f.local.data.get(KEY)),intent=JSON.parse(f.tab.data.get(f.persistence.intentKey));
  assert.equal(marker.state,'signed_out');assert.equal(intent.baseEpoch,marker.epoch);
  const returned=f.create();const replacement=session(USER_A,SESSION_B,'after-idle');
  returned.storage.setItem(KEY,JSON.stringify(replacement));assert.equal(returned.accepts(replacement),true);
});

test('beginning sign-in before the initial legacy read preserves the migrated baseline and tab handoff keys',async()=>{
  const tab=stored([[KEY,JSON.stringify(session())],[KEY+'-code-verifier','verifier'],['offscript.signin-draft.v1','draft']]);
  const f=fixture({tab});await f.persistence.beginSignIn(true);
  const migrated=JSON.parse(f.local.data.get(KEY)),intent=JSON.parse(f.tab.data.get(f.persistence.intentKey));
  assert.equal(intent.baseEpoch,migrated.epoch);assert.equal(intent.previousSessionId,SESSION_A);
  const replacement=session(USER_A,SESSION_B,'provider-return');f.persistence.storage.setItem(KEY,JSON.stringify(replacement));
  assert.equal(f.persistence.accepts(replacement),true);assert.equal(tab.data.get(KEY+'-code-verifier'),'verifier');
  assert.equal(tab.data.get('offscript.signin-draft.v1'),'draft');
});

test('a failed tombstone write deletes only the scoped credentials and fences late refreshes',async()=>{
  const local=stored([['unrelated','keep']]);let rejectMarkers=false;
  const storage={...local.storage,setItem(key,value){
    if(rejectMarkers&&key===KEY&&JSON.parse(value).state==='signed_out')throw Error('simulated replacement failure');
    local.storage.setItem(key,value);
  }};
  const f=fixture({local:{...local,storage}});await signIn(f.persistence);const old=f.persistence.lease();
  rejectMarkers=true;f.persistence.storage.removeItem(KEY);
  assert.equal(local.data.has(KEY),false);assert.equal(local.data.get('unrelated'),'keep');
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_A,'late')));
  assert.equal(f.persistence.isActive(),false);assert.equal(f.persistence.leaseCurrent(old),false);
  assert.equal(f.create(stored().storage).storage.getItem(KEY),null);
  const replacement=session(USER_A,SESSION_B,'deliberate-replacement');await signIn(f.persistence,replacement);
  assert.equal(f.persistence.accepts(replacement),true);
});

test('failed deletion leaves an in-memory revocation fence across repeated attempts and reports the storage failure',async()=>{
  const local=stored();let failing=false;
  const storage={...local.storage,setItem(key,value){if(failing&&key===KEY)throw Error('simulated write failure');local.storage.setItem(key,value);},
    removeItem(key){if(failing&&key===KEY)throw Error('simulated delete failure');local.storage.removeItem(key);}};
  const f=fixture({local:{...local,storage}});await signIn(f.persistence);let reads=0;
  const reader=guardedAccountReader({getSession:async()=>{reads++;return result(session());},refreshSession:async()=>{reads++;return result(session());}},f.persistence);
  failing=true;
  assert.throws(()=>f.persistence.storage.removeItem(KEY),/Clear this site/);
  assert.equal(f.persistence.storage.getItem(KEY),null);assert.equal(f.persistence.isActive(),false);
  assert.throws(()=>f.persistence.storage.removeItem(KEY),/Clear this site/);
  assert.equal(f.persistence.isActive(),false,'A second failure must not fence only the virtual marker instead of the old credentials');
  await assert.rejects(reader.getSession(),SessionExpiredError);assert.equal(reads,0);
  f.persistence.storage.setItem(KEY,JSON.stringify(session(USER_A,SESSION_A,'late')));assert.equal(f.persistence.isActive(),false);
  failing=false;const replacement=session(USER_A,SESSION_B,'recovered-storage');await signIn(f.persistence,replacement);
  assert.equal(f.persistence.accepts(replacement),true);
});
