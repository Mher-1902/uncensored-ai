// Disposable integration only: browser client -> public binding -> private
// bridge -> actual native HTTP gateway -> synthetic engine + real PostgreSQL.
// No external URL, real account, provider credential or model prompt is accepted.
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createGateway} from '../server/index.mjs';
import {createBridge} from '../cloud/vercel-gateway/index.mjs';
import {createAppHandler} from '../cloud/vercel-api/handler.mjs';
import {createAccountStore} from '../cloud/vercel-gateway/account-store.mjs';
import {reply} from '../src/api.ts';

assert.equal(process.env.OFFSCRIPT_TEST_FIXTURE,'disposable-postgres');
const require=createRequire(new URL('../cloud/vercel-gateway/package.json',import.meta.url));
const {Pool}=require('pg');
const db=new Pool({host:'127.0.0.1',port:5432,database:'offscript_test',user:'postgres',password:'disposable-test-only',max:2,connectionTimeoutMillis:3000,query_timeout:5000});
assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name,'offscript_test');
if((await db.query("SELECT to_regclass('public.offscript_accounts') AS installed")).rows[0].installed===null){
  await db.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;`);
  for(const name of ['202610170001_pilot_accounts.sql','202610170002_logical_answers.sql'])await db.query(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await db.query('CREATE ROLE offscript_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION; GRANT offscript_gateway TO offscript_runtime;');
}
const user='11111111-1111-4111-8111-111111111111',token='t'.repeat(40),lifetimes=[],generated=[];
const pool=new EventEmitter();pool.end=async()=>{};
pool.query=async(sql,values)=>{
  const client=await db.connect();
  try {await client.query('SET ROLE offscript_runtime');return await client.query(sql,values)}
  finally {await client.query('RESET ROLE');client.release()}
};
const backingStore=createAccountStore({env:{PILOT_DATABASE_URL:'postgresql://offscript_runtime:dummy@db.fixture.supabase.co/postgres'},poolFactory:async()=>pool});
const store={...backingStore,startAnswer:async(...args)=>{
  const result=await backingStore.startAnswer(...args);
  if(phase==='before'){
    const cancellation=await globalThis.fetch('https://app.test/api/answer/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-Offscript-Client':'web',Authorization:'Bearer dummy-session'},body:JSON.stringify({answerId:result.answerId})});
    assert.deepEqual(await cancellation.json(),{state:'finished'});
  }
  return result;
}};
await db.query('INSERT INTO auth.users(id) VALUES($1::uuid) ON CONFLICT DO NOTHING',[user]);
await store.account(user);
await db.query("UPDATE public.offscript_accounts SET status='active',eligibility='eligible' WHERE user_id=$1::uuid",[user]);
await db.query("UPDATE offscript_private.settings SET daily_requests=100,daily_deep_requests=100,daily_tokens=1000000,policies_published=true,terms_version='runtime-terms-v1',privacy_version='runtime-privacy-v1'");
await store.accept(user,'runtime-terms-v1','runtime-privacy-v1');
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
let phase='complete',disposals=0,chatCalls=0,stopController;
const engine={ready:async()=>true,dispose:async()=>{disposals++;return true},prepare:async input=>input,
  generate:async(input,signal)=>{
    generated.push(input);
    if(phase==='during')return new Response(new ReadableStream({start(output){
      output.enqueue(new TextEncoder().encode(frame({choices:[{delta:{content:'Partial'}}]})));
      signal.addEventListener('abort',()=>output.close(),{once:true});
    }}));
    const next=input.continuation;
    return new Response(frame({choices:[{delta:{content:next?'world.':'Hello '},finish_reason:next?'stop':'length'}]})
      +frame({usage:{prompt_tokens:next?450:100,completion_tokens:next?20:input.mode==='deep'?300:30}})+'data: [DONE]\n\n');
  }};
const native=createGateway({engine,accessToken:token,origins:['https://app.test']});
native.listen(0,'127.0.0.1');await once(native,'listening');
const originalFetch=globalThis.fetch,nativeOrigin=`http://127.0.0.1:${native.address().port}`;
const bridge=createBridge({env:{PILOT_ACCOUNT_CONTROL:'true',SUPABASE_URL:'https://fixture.supabase.co',SAMSUNG_API_ORIGIN:'https://fixture-worker.test',SAMSUNG_GATEWAY_TOKEN:token},
  accountStore:store,defer:promise=>lifetimes.push(promise),verify:async value=>{assert.equal(value,'Bearer dummy-session');return user},
  fetchImpl:(url,options)=>{
    assert.equal(url.origin,'https://fixture-worker.test');assert.equal(options.headers.Authorization,'Bearer '+token);
    return originalFetch(new URL(url.pathname,nativeOrigin),options);
  }});
globalThis.location={origin:'https://app.test'};
globalThis.fetch=async(url,options)=>{
  const target=new URL(url);assert.equal(target.origin,'https://app.test');
  if(target.pathname==='/api/chat'){
    chatCalls++;
    if(phase==='gap'&&JSON.parse(options.body).continuation){stopController.abort();options.signal.throwIfAborted()}
  }
  return createAppHandler(target.pathname,{env:{GATEWAY_URL:'https://fixture-binding.test'},fetchImpl:(internal,init)=>{
    assert.equal(internal.origin,'https://fixture-binding.test');return bridge(new Request(internal,init));
  }})(new Request(url,options));
};
const config={apiBase:'https://app.test/api',space:null,requireAuth:true,accountControl:true};
const messages=[{id:'dummy-question',role:'user',content:'Synthetic fixture',complete:true}];
const usage=async()=> (await db.query('SELECT requests_used,deep_used,tokens_used,requests_reserved,tokens_reserved FROM public.offscript_usage_daily WHERE user_id=$1::uuid AND day=CURRENT_DATE',[user])).rows[0];
try {
  let text='';
  await reply(config,messages,true,new AbortController().signal,value=>{text=value},()=>{},'dummy-session');
  await Promise.all(lifetimes);
  assert.equal(text,'Hello world.');assert.equal(chatCalls,2);assert.equal(generated[0].mode,'deep');assert.equal(generated[1].mode,'fast');
  assert.deepEqual(await usage(),{requests_used:1,deep_used:1,tokens_used:'420',requests_reserved:0,tokens_reserved:'0'});
  console.log('PASS complete answer uses real SQL receipts, one request/Deep allowance and hidden-token accounting');

  phase='during';stopController=new AbortController();text='';
  await assert.rejects(reply(config,messages,false,stopController.signal,value=>{text=value;stopController.abort()},()=>{},'dummy-session'),{name:'AbortError'});
  await Promise.all(lifetimes);
  assert.equal(text,'Partial');assert.equal((await usage()).requests_reserved,0);
  assert.equal((await db.query("SELECT count(*)::int AS open FROM offscript_private.answers WHERE state<>'finished'")).rows[0].open,0);
  assert.equal((await (await originalFetch(nativeOrigin+'/api/health')).json()).busy,false);
  console.log('PASS Stop during inference traverses the actual native cleanup registry before SQL capacity is released');

  phase='gap';stopController=new AbortController();const before=generated.length;
  await assert.rejects(reply(config,messages,false,stopController.signal,()=>{},()=>{},'dummy-session'),{name:'AbortError'});
  await Promise.all(lifetimes);
  assert.equal(generated.length,before+1);assert.equal((await usage()).requests_reserved,0);
  assert.equal((await db.query("SELECT count(*)::int AS open FROM offscript_private.answers WHERE state<>'finished'")).rows[0].open,0);
  assert.equal(disposals,generated.length*2);
  console.log('PASS Stop between segments closes the real waiting handoff without dispatching another model request');

  phase='before';const beforeDispatch=generated.length,beforeUsage=await usage();
  await assert.rejects(reply(config,messages,false,new AbortController().signal,()=>{},()=>{},'dummy-session'));
  await Promise.all(lifetimes);
  assert.equal(generated.length,beforeDispatch);assert.equal((await usage()).requests_reserved,0);
  assert.equal((await usage()).requests_used,beforeUsage.requests_used);assert.equal((await usage()).tokens_used,beforeUsage.tokens_used);
  assert.equal((await db.query("SELECT count(*)::int AS open FROM offscript_private.answers WHERE state<>'finished'")).rows[0].open,0);
  console.log('PASS Stop after database admission but before dispatch prevents a late model request from starting');
  console.log(JSON.stringify({answer_stack_checks:4,result:'passed',engine:'synthetic',database:'disposable',external_network:false}));
} finally {
  globalThis.fetch=originalFetch;delete globalThis.location;
  native.closeAllConnections();native.close();await db.end();
}
