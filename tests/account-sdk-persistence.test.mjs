import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {ACCOUNT_IDLE_MS,createAccountPersistence,guardedAccountReader} from '../src/account-persistence.ts';
import {SessionExpiredError} from '../src/session.ts';

const USER='11111111-1111-4111-8111-111111111111';
const SESSION='22222222-2222-4222-8222-222222222222';
const DAY=24*60*60*1000;
let fixtureId=0;

function memoryStorage(){
  const data=new Map();
  return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value);},removeItem:key=>{data.delete(key);}};
}

// This is the shared exclusive-lock contract passed to the real SDK and adapter.
// A fresh client shares the manager but never inherits another tab's storage.
function sharedLock(){
  const tails=new Map();
  return async(name,_timeout,work)=>{
    const previous=tails.get(name)??Promise.resolve();let release;
    const next=new Promise(resolve=>{release=resolve;});tails.set(name,next);
    await previous.catch(()=>{});
    try{return await work();}finally{release();if(tails.get(name)===next)tails.delete(name);}
  };
}

function tokenResponse(label='initial'){
  const now=Math.floor(Date.now()/1000),expires=now+60*24*60*60;
  const claims={sub:USER,session_id:SESSION,aud:'authenticated',role:'authenticated',iat:now,exp:expires};
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode(claims)}.${Buffer.from(label).toString('base64url')}`,
    token_type:'bearer',refresh_token:`dummy-refresh-${label}`,expires_in:expires-now,expires_at:expires,
    user:{id:USER,aud:'authenticated',role:'authenticated',email:'fixture@example.invalid',
      app_metadata:{provider:'email',providers:['email']},user_metadata:{},identities:[],
      created_at:new Date(now*1000).toISOString(),updated_at:new Date(now*1000).toISOString(),is_anonymous:false},
  };
}

function jsonResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}

function fixture(t){
  const origin=`https://sdkfixture${++fixtureId}.supabase.co`;
  const local=memoryStorage(),clock={value:Date.now()},lock=sharedLock(),clients=[],calls=[],unexpected=[];
  let ids=0,handler=()=>{throw Error('No fake response configured');};
  const fakeFetch=async(input,init={})=>{
    const request=new Request(input,init),url=new URL(request.url);
    const text=request.method==='POST'?await request.text():'';
    const body=text?JSON.parse(text):null;
    const call={url,method:request.method,body,authorization:request.headers.get('authorization')};calls.push(call);
    if(url.origin!==origin||!url.pathname.startsWith('/auth/v1/')||!['POST','GET'].includes(request.method)){
      unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
      return jsonResponse({msg:'Unexpected dummy request',code:'fixture_request_rejected'},400);
    }
    try{return await handler(call);}catch(error){
      unexpected.push(error instanceof Error?error.message:String(error));
      return jsonResponse({msg:'Unexpected dummy request',code:'fixture_request_rejected'},400);
    }
  };
  async function client(tab=memoryStorage()){
    const saved=createAccountPersistence({url:origin,persistent:local,temporary:tab,sharedLock:lock,
      now:()=>clock.value,id:()=>`sdk-fixture-${++ids}`});
    const sdk=createClient(origin,'dummy-publishable-key',{
      global:{fetch:fakeFetch},
      auth:{persistSession:true,storageKey:saved.storageKey,storage:saved.storage,lock:saved.lock,
        flowType:'pkce',detectSessionInUrl:false,autoRefreshToken:false},
    });
    const events=[];
    const {data:{subscription}}=sdk.auth.onAuthStateChange((event,value)=>{events.push({event,session:value});});
    const owner={sdk,saved,tab,events,close:async()=>{subscription.unsubscribe();await sdk.auth.stopAutoRefresh();saved.dispose();}};
    clients.push(owner);
    const initialized=await sdk.auth.getSession();assert.equal(initialized.error,null);
    return owner;
  }
  t.after(async()=>{
    for(const owner of clients)await owner.close();
    assert.deepEqual(unexpected,[],'All SDK network requests must match the isolated fake auth server');
  });
  return {origin,local,clock,calls,client,respond(value){handler=value;}};
}

async function passwordSignIn(f,owner,response=tokenResponse()){
  f.respond(call=>{
    assert.equal(call.method,'POST');assert.equal(call.url.pathname,'/auth/v1/token');
    assert.equal(call.url.searchParams.get('grant_type'),'password');
    assert.equal(call.body.email,'fixture@example.invalid');assert.equal(call.body.password,'dummy-password');
    return jsonResponse(response);
  });
  await owner.saved.beginSignIn();
  const result=await owner.sdk.auth.signInWithPassword({email:'fixture@example.invalid',password:'dummy-password'});
  assert.equal(result.error,null);assert.equal(owner.saved.accepts(result.data.session),true);
  return result.data.session;
}

test('the real SDK restores the browser envelope in a fresh tab without another sign-in request',{timeout:10000},async t=>{
  const f=fixture(t),first=await f.client(),signedIn=await passwordSignIn(f,first);
  const envelope=JSON.parse(f.local.data.get(first.saved.storageKey));
  assert.equal(envelope.state,'active');assert.equal(envelope.sessionId,SESSION);
  assert.equal(envelope.lastActivityAt,f.clock.value);
  assert.equal(JSON.parse(envelope.session).access_token,signedIn.access_token);
  assert.equal(first.tab.data.has(first.saved.storageKey),false);
  await first.close();
  f.clock.value+=29*DAY;
  const returning=await f.client(),result=await returning.sdk.auth.getSession();
  assert.equal(result.error,null);assert.equal(result.data.session.access_token,signedIn.access_token);
  assert.equal(returning.saved.accepts(result.data.session),true);
  assert.equal(JSON.parse(f.local.data.get(returning.saved.storageKey)).lastActivityAt,envelope.lastActivityAt);
  assert.equal(f.calls.length,1,'Restoring a valid session must not call the provider or auth API');
});

test('the real SDK preserves PKCE in the same tab across the provider redirect and consumes it on exchange',{timeout:10000},async t=>{
  const f=fixture(t),before=await f.client();
  await before.saved.beginSignIn(true);
  const redirect=await before.sdk.auth.signInWithOAuth({provider:'github',options:{redirectTo:'https://offscript.example.invalid/',skipBrowserRedirect:true}});
  assert.equal(redirect.error,null);
  const authorize=new URL(redirect.data.url);
  assert.equal(authorize.origin,f.origin);assert.equal(authorize.pathname,'/auth/v1/authorize');
  assert.equal(authorize.searchParams.get('provider'),'github');
  assert.equal(authorize.searchParams.get('redirect_to'),'https://offscript.example.invalid/');
  assert.equal(authorize.searchParams.get('code_challenge_method'),'s256');
  const verifierKey=before.saved.storageKey+'-code-verifier';
  const verifier=JSON.parse(before.tab.data.get(verifierKey));
  assert.equal(typeof verifier,'string');assert.ok(verifier.length>=43);
  assert.equal(authorize.searchParams.get('code_challenge'),createHash('sha256').update(verifier).digest('base64url'));
  assert.ok([...before.tab.data.keys()].some(key=>key.includes('-flow-')&&key.endsWith('-code-verifier')));
  assert.equal([...f.local.data.keys()].some(key=>key.includes('code-verifier')),false);
  assert.equal(f.calls.length,0,'Building the provider URL must not visit a real provider');
  await before.close();
  const callback=await f.client(before.tab),response=tokenResponse('pkce');
  f.respond(call=>{
    assert.equal(call.method,'POST');assert.equal(call.url.pathname,'/auth/v1/token');
    assert.equal(call.url.searchParams.get('grant_type'),'pkce');
    assert.deepEqual(call.body,{auth_code:'dummy-provider-code',code_verifier:verifier});
    return jsonResponse(response);
  });
  const exchanged=await callback.sdk.auth.exchangeCodeForSession('dummy-provider-code');
  assert.equal(exchanged.error,null);assert.equal(callback.saved.accepts(exchanged.data.session),true);
  assert.equal(callback.tab.data.has(verifierKey),false);
  assert.equal(callback.tab.data.has(callback.saved.intentKey),false);
  const restored=await callback.sdk.auth.getSession();
  assert.equal(restored.data.session.access_token,response.access_token);
  assert.equal(f.calls.length,1);
});

test('explicit local sign-out through the real SDK removes credentials and leaves a fresh tab signed out',{timeout:10000},async t=>{
  const f=fixture(t),owner=await f.client(),signedIn=await passwordSignIn(f,owner);
  f.respond(call=>{
    assert.equal(call.method,'POST');assert.equal(call.url.pathname,'/auth/v1/logout');
    assert.equal(call.url.searchParams.get('scope'),'local');
    assert.equal(call.authorization,`Bearer ${signedIn.access_token}`);
    return jsonResponse({});
  });
  const result=await owner.sdk.auth.signOut({scope:'local'});assert.equal(result.error,null);
  assert.equal(owner.saved.isActive(),false);
  const raw=f.local.data.get(owner.saved.storageKey),marker=JSON.parse(raw);
  assert.equal(marker.state,'signed_out');assert.equal(raw.includes('access_token'),false);assert.equal(raw.includes('refresh_token'),false);
  assert.equal((await owner.sdk.auth.getSession()).data.session,null);
  const returning=await f.client();assert.equal((await returning.sdk.auth.getSession()).data.session,null);
  assert.equal(f.calls.length,2);
});

test('a same-session refresh through the real SDK rotates credentials without extending the inactivity window',{timeout:10000},async t=>{
  const f=fixture(t),owner=await f.client(),signedIn=await passwordSignIn(f,owner);
  const before=JSON.parse(f.local.data.get(owner.saved.storageKey));
  f.clock.value+=29*DAY;const refreshed=tokenResponse('rotated');
  f.respond(call=>{
    assert.equal(call.method,'POST');assert.equal(call.url.pathname,'/auth/v1/token');
    assert.equal(call.url.searchParams.get('grant_type'),'refresh_token');
    assert.equal(call.body.refresh_token,signedIn.refresh_token);return jsonResponse(refreshed);
  });
  const result=await guardedAccountReader(owner.sdk.auth,owner.saved).refreshSession();
  assert.equal(result.error,null);assert.equal(result.data.session.access_token,refreshed.access_token);
  const after=JSON.parse(f.local.data.get(owner.saved.storageKey));
  assert.equal(after.epoch,before.epoch);assert.equal(after.lastActivityAt,before.lastActivityAt);
  assert.equal(JSON.parse(after.session).refresh_token,refreshed.refresh_token);
  f.clock.value=before.lastActivityAt+ACCOUNT_IDLE_MS;
  assert.equal(owner.saved.isActive(),false);
  assert.equal((await owner.sdk.auth.getSession()).data.session,null);
  assert.equal(JSON.parse(f.local.data.get(owner.saved.storageKey)).state,'signed_out');
});

test('an in-flight real SDK refresh cannot revive an expired browser session or return a usable chat token',{timeout:10000},async t=>{
  const f=fixture(t),owner=await f.client();await passwordSignIn(f,owner);
  const original=JSON.parse(f.local.data.get(owner.saved.storageKey));
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),fetchStarted=new Promise(resolve=>{started=resolve;});
  f.respond(async call=>{
    assert.equal(call.method,'POST');assert.equal(call.url.pathname,'/auth/v1/token');
    assert.equal(call.url.searchParams.get('grant_type'),'refresh_token');started();await gate;
    return jsonResponse(tokenResponse('too-late'));
  });
  const pending=guardedAccountReader(owner.sdk.auth,owner.saved).refreshSession();
  try{
    await fetchStarted;f.clock.value=original.lastActivityAt+ACCOUNT_IDLE_MS;
    assert.equal(owner.saved.isActive(),false);
  }finally{release();}
  await assert.rejects(pending,SessionExpiredError);
  assert.equal(owner.saved.isActive(),false);
  assert.equal((await owner.sdk.auth.getSession()).data.session,null);
  const marker=JSON.parse(f.local.data.get(owner.saved.storageKey));assert.equal(marker.state,'signed_out');
  assert.equal(f.local.data.get(owner.saved.storageKey).includes('access_token'),false);
  const returning=await f.client();assert.equal((await returning.sdk.auth.getSession()).data.session,null);
  assert.equal(f.calls.length,2);
});
