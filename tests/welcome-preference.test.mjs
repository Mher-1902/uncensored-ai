import test from 'node:test';
import assert from 'node:assert/strict';
import {hasSeenWelcome,welcomeNeeded,rememberWelcome,WELCOME_FIELD,WELCOME_VERSION} from '../src/welcome-preference.ts';
const user=(id='account-a',marker)=>({id,user_metadata:marker===undefined?{}:{[WELCOME_FIELD]:marker}});
const marker=(forUser='account-a',version=WELCOME_VERSION)=>({version,forUser});
const config={url:'https://exampleproject.supabase.co',publishableKey:'sb_publishable_abcdefghijklmnopqrstuv'};
const session=(id='account-a',value)=>({user:user(id,value),access_token:`credential-for-${id}`});
const authFor=value=>({async getSession(){return {data:{session:value},error:null}}});
const noRequest=async()=>assert.fail('Must not send an account update');
test('a versioned display preference follows its own account, without a signup-time guess',()=>{
  assert.equal(hasSeenWelcome(user('account-a',marker())),true);
  assert.equal(hasSeenWelcome(user('account-b',marker())),false);
  for(const value of [null,[],true,'accepted',{},marker('account-a','old'),{version:WELCOME_VERSION}])assert.equal(hasSeenWelcome(user('account-a',value)),false);
  assert.equal(hasSeenWelcome({...user(),created_at:'same',last_sign_in_at:'same'}),false);
});
test('explicit dismissal sends only the display field to the configured account endpoint',async()=>{
  const calls=[];
  const request=async(url,options)=>{
    calls.push({url:String(url),options});
    return Response.json(user('account-a',JSON.parse(options.body).data[WELCOME_FIELD]));
  };
  assert.equal(await rememberWelcome(authFor(session()),'account-a',config,request),true);
  assert.equal(calls.length,1);
  const {url,options}=calls[0];
  assert.equal(url,config.url+'/auth/v1/user');
  assert.equal(options.method,'PUT');
  assert.deepEqual(options.headers,{apikey:config.publishableKey,Authorization:'Bearer credential-for-account-a','Content-Type':'application/json'});
  assert.deepEqual(JSON.parse(options.body),{data:{[WELCOME_FIELD]:marker()}});
  assert.doesNotMatch(options.body,/password|access_token|refresh_token|terms|consent|chat|email|role/);
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.cache,'no-store');
  assert.equal(options.signal instanceof AbortSignal,true);
});
test('an existing preference needs no repeat write after sign-in on another device',async()=>{
  assert.equal(await rememberWelcome(authFor(session('account-a',marker())),'account-a',config,noRequest),true);
});
test('missing, expired, credentialless and switched sessions cannot initiate a preference write',async()=>{
  for(const result of [{data:{session:null},error:null},{data:{session:session()},error:Error('expired')},{data:{session:session('account-b')},error:null},{data:{session:{user:user()}},error:null}]){
    assert.equal(await rememberWelcome({async getSession(){return result}},'account-a',config,noRequest),false);
  }
});
test('a session switch after the snapshot cannot write or overwrite the new account metadata',async()=>{
  let current=session();
  const users=new Map([['account-a',user()],['account-b',user('account-b',marker('account-b'))]]);
  const beforeB=structuredClone(users.get('account-b'));
  const auth={async getSession(){const captured=current;current=session('account-b');return {data:{session:captured},error:null}},async updateUser(){assert.fail('Do not use mutable SDK session for this write')}};
  const request=async(url,options)=>{
    assert.equal(current.user.id,'account-b');
    const target=options.headers.Authorization==='Bearer credential-for-account-a'?'account-a':current.user.id;
    const saved={...users.get(target),user_metadata:{...users.get(target).user_metadata,...JSON.parse(options.body).data}};
    users.set(target,saved);
    return Response.json(saved);
  };
  assert.equal(await rememberWelcome(auth,'account-a',config,request),true);
  assert.deepEqual(users.get('account-b'),beforeB);
  assert.equal(hasSeenWelcome(users.get('account-a')),true);
});
test('unexpected response identity is rejected without replacing the current SDK session',async()=>{
  const auth={...authFor(session()),setSession(){assert.fail('Never restore an old SDK session')}};
  assert.equal(await rememberWelcome(auth,'account-a',config,async()=>Response.json(user('account-b',marker('account-b')))),false);
});
test('credentials cannot be sent to a different origin, path, redirect or nonpublic key configuration',async()=>{
  for(const url of ['http://exampleproject.supabase.co','https://attacker.test','https://exampleproject.supabase.co/','https://exampleproject.supabase.co/path','https://user:password@exampleproject.supabase.co','https://exampleproject.supabase.co?next=other','https://exampleproject.supabase.co:444']){
    assert.equal(await rememberWelcome(authFor(session()),'account-a',{...config,url},noRequest),false);
  }
  assert.equal(await rememberWelcome(authFor(session()),'account-a',{...config,publishableKey:'server-secret'},noRequest),false);
});
test('blocked, rejected, malformed or failed sync stays a nonfatal display preference',async()=>{
  assert.equal(await rememberWelcome({getSession:async()=>{throw Error('private diagnostic')}},'account-a',config,noRequest),false);
  for(const request of [async()=>{throw Error('private')},async()=>new Response('',{status:401}),async()=>new Response('not json'),async()=>Response.json(null),async()=>Response.json(user())]){
    assert.equal(await rememberWelcome(authFor(session()),'account-a',config,request),false);
  }
});

test('a restored stale session does not repeat a welcome already dismissed on the server',async()=>{
  const cached=session();
  let saved=user();
  const request=async(url,options)=>{
    assert.equal(String(url),config.url+'/auth/v1/user');
    assert.equal(options.headers.Authorization,'Bearer credential-for-account-a');
    if(options.method==='PUT')saved=user('account-a',JSON.parse(options.body).data[WELCOME_FIELD]);
    else assert.equal(options.method,'GET');
    return Response.json(saved);
  };
  assert.equal(await welcomeNeeded(cached,config,request),true);
  assert.equal(await rememberWelcome(authFor(cached),'account-a',config,request),true);
  assert.equal(hasSeenWelcome(cached.user),false); // SDK intentionally remains unchanged.
  assert.equal(await welcomeNeeded(cached,config,request),false);
});
test('authoritative welcome reads reject a different account, unknown state and transport failure',async()=>{
  assert.equal(await welcomeNeeded(session('account-a',marker()),config,noRequest),false);
  for(const request of [async()=>Response.json(user('account-b')),async()=>Response.json(null),async()=>new Response('',{status:401}),async()=>{throw Error('offline')}]){
    assert.equal(await welcomeNeeded(session(),config,request),false);
  }
});
