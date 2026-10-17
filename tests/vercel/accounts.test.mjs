import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AccountError,accountControlEnabled,createAccountStore,databaseOptions} from '../../cloud/vercel-gateway/account-store.mjs';
import {createBridge} from '../../cloud/vercel-gateway/index.mjs';
import {createAppHandler} from '../../cloud/vercel-api/handler.mjs';

const user='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const env={PILOT_ACCOUNT_CONTROL:'true',SUPABASE_URL:'https://project.supabase.co',SAMSUNG_API_ORIGIN:'https://worker.test',SAMSUNG_GATEWAY_TOKEN:'t'.repeat(40)};
const request=(path='/api/chat',data={messages:[{role:'user',content:'Hello'}],maxTokens:256,mode:'fast'})=>new Request('https://app.test'+path,{
  method:path==='/api/account'?'GET':'POST',headers:{Authorization:'Bearer dummy','Content-Type':'application/json','X-Offscript-Client':'web'},...(path==='/api/account'?{}:{body:JSON.stringify(data)}),
});
const metadata={plan:'free',status:'active',eligibility:'eligible',policies:{published:true,termsVersion:'terms-v1',privacyVersion:'privacy-v1',accepted:true},usage:{requestsRemaining:9,deepRemaining:2,tokensRemaining:19000}};
const frame=(event)=>'data: '+JSON.stringify(event)+'\n\n';
function fixture(extra={}) {
  const calls=[];
  const store={account:async(...args)=>{calls.push(['account',...args]);return metadata},accept:async(...args)=>{calls.push(['accept',...args]);return metadata},
    reserve:async(...args)=>{calls.push(['reserve',...args]);return {}},finish:async(...args)=>{calls.push(['finish',...args]);return {state:args.at(-1)?'finished':'uncertain'}},...extra.store};
  const fetchImpl=async(url,options)=>{
    calls.push(['worker',url.pathname,options]);
    if(url.pathname==='/api/health')return Response.json({ready:true,protocol:extra.protocol??3});
    if(extra.response)return extra.response(options);
    return new Response(frame({choices:[{delta:{content:'Hello'},finish_reason:'stop'}]})+frame({usage:{prompt_tokens:8,completion_tokens:2}})+frame({control:{workerStopped:true,outcome:'completed'}})+'data: [DONE]\n\n',{
      headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'3'},
    });
  };
  const bridge=createBridge({env:{...env,...extra.env},accountStore:store,verify:async authorization=>{if(authorization!=='Bearer dummy')throw Error();return user},fetchImpl});
  return {calls,store,bridge};
}

test('private database configuration enforces managed hosts, a dedicated login, verified TLS and a bounded pool',()=>{
  const good={PILOT_DATABASE_URL:'postgresql://offscript_runtime.project:dummy@aws-1-eu-central-1.pooler.supabase.com:6543/postgres'};
  const options=databaseOptions(good);assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.max,2);assert.equal(options.connectionTimeoutMillis,5000);
  for(const url of ['postgresql://postgres:dummy@db.project.supabase.co/postgres',good.PILOT_DATABASE_URL+'?sslmode=disable',good.PILOT_DATABASE_URL.replace('.supabase.com','.evil.test'),good.PILOT_DATABASE_URL.replace('/postgres','/other'),''])assert.throws(()=>databaseOptions({PILOT_DATABASE_URL:url}),AccountError);
  assert.equal(accountControlEnabled({}),false);assert.throws(()=>accountControlEnabled({PILOT_ACCOUNT_CONTROL:'TRUE'}),AccountError);
});

test('SQL calls are parameterized and privileged or misconfigured database roles fail closed',async()=>{
  const calls=[];const pool=new EventEmitter();pool.end=async()=>{};
  pool.query=async(sql,values)=>{calls.push([sql,values]);return {rows:[values?{result:metadata}:{name:'offscript_runtime',restricted:true}]}};
  const store=createAccountStore({env:{PILOT_DATABASE_URL:'postgresql://offscript_runtime:dummy@db.project.supabase.co/postgres'},poolFactory:async()=>pool});
  await store.accept(user,'terms-v1','privacy-v1');
  assert.deepEqual(calls[1][1],[user,'terms-v1','privacy-v1']);assert.doesNotMatch(calls[1][0],/terms-v1|11111111/);
  const bad=new EventEmitter();let ended=false;bad.end=async()=>{ended=true};bad.query=async()=>({rows:[{name:'offscript_runtime',restricted:false}]});
  await assert.rejects(createAccountStore({env:{PILOT_DATABASE_URL:'postgresql://offscript_runtime:dummy@db.project.supabase.co/postgres'},poolFactory:async()=>bad}).account(user),AccountError);
  assert.equal(ended,true);
});

test('account and acceptance use the verified subject; user-selected ownership and unchecked acceptance are rejected',async()=>{
  const f=fixture();const account=await f.bridge(request('/api/account'));assert.deepEqual(await account.json(),metadata);
  const data={accepted:true,termsVersion:'terms-v1',privacyVersion:'privacy-v1'};
  assert.equal((await f.bridge(request('/api/acceptance',data))).status,200);
  assert.deepEqual(f.calls,[['account',user],['accept',user,'terms-v1','privacy-v1']]);
  for(const body of [{...data,userId:other},{...data,accepted:false},{...data,privacyVersion:'a'.repeat(65)}])assert.equal((await f.bridge(request('/api/acceptance',body))).status,400);
  const missing=request('/api/account');missing.headers.delete('authorization');assert.equal((await f.bridge(missing)).status,401);
});

test('a disabled deployment never calls the account store and enabled missing database settings never reaches inference',async()=>{
  const disabled=fixture({env:{PILOT_ACCOUNT_CONTROL:'false'},store:{account:()=>{throw Error('Must not be called')}}});
  assert.equal((await disabled.bridge(request('/api/account'))).status,404);
  const enabled=createBridge({env,verify:async()=>user,fetchImpl:()=>{throw Error('Must not infer')}});
  const response=await enabled(request('/api/account'));assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/password|postgresql|stack/);
});

test('admission precedes generation; completion is acknowledged only after database settlement',async()=>{
  let finish;
  const f=fixture({store:{finish:async(...args)=>{f.calls.push(['finish',...args]);await new Promise(resolve=>{finish=resolve});return {state:'finished'}}}});
  const response=await f.bridge(request());const result=response.text();let ended=false;void result.then(()=>{ended=true});
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ended,false);
  const reserve=f.calls.find(c=>c[0]==='reserve');assert.equal(reserve[1],user);assert.equal(reserve[3],'fast');assert.equal(reserve[4],256);
  assert.ok(f.calls.findIndex(c=>c[0]==='reserve')<f.calls.findIndex(c=>c[0]==='worker'&&c[1]==='/api/chat'));
  const settled=f.calls.find(c=>c[0]==='finish');assert.deepEqual(settled.slice(1),[user,reserve[2],'completed',8,2,true]);
  finish();const text=await result;assert.match(text,/\[DONE\]/);assert.doesNotMatch(text,/control|workerStopped/);
});

test('quota errors survive the public binding with approved wording and no database details',async()=>{
  const f=fixture({store:{reserve:async()=>{throw new AccountError('quota_exceeded')}}});
  const handler=createAppHandler('/api/chat',{env:{GATEWAY_URL:'https://internal.test'},fetchImpl:(url,options)=>f.bridge(new Request(url,options))});
  const result=await handler(request());assert.equal(result.status,429);assert.equal((await result.json()).code,'quota_exceeded');
  assert.equal(f.calls.some(c=>c[0]==='worker'&&c[1]==='/api/chat'),false);
});

test('old workers cannot admit a lease and unconfirmed completion retains an uncertain lease',async()=>{
  const old=fixture({protocol:2});assert.equal((await old.bridge(request())).status,503);assert.equal(old.calls.some(c=>c[0]==='reserve'),false);
  const broken=fixture({response:()=>new Response(frame({choices:[{delta:{content:'Partial'}}]})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'3'}})});
  await assert.rejects((await broken.bridge(request())).text(),/finalized/);
  assert.equal(broken.calls.find(c=>c[0]==='finish').at(-1),false);
});

test('failed database settlement withholds DONE even after the worker confirms cleanup',async()=>{
  const f=fixture({store:{finish:async()=>{throw Error('private database detail')}}});
  await assert.rejects((await f.bridge(request())).text(),error=>!error.message.includes('private database detail'));
});

test('a confirmed pre-start worker rejection refunds admission, while a disconnect does not',async()=>{
  const rejected=fixture({response:()=>Response.json({error:'internal detail',control:{workerStopped:true,outcome:'rejected'}},{status:422,headers:{'X-Offscript-Protocol':'3'}})});
  const result=await rejected.bridge(request());assert.equal(result.status,422);assert.doesNotMatch(await result.text(),/internal detail/);
  assert.equal(rejected.calls.find(c=>c[0]==='finish')[3],'rejected');assert.equal(rejected.calls.find(c=>c[0]==='finish').at(-1),true);
  const cancelled=fixture({response:options=>new Response(new ReadableStream({start(output){output.enqueue(new TextEncoder().encode(frame({choices:[{delta:{content:'First'}}]})));options.signal.addEventListener('abort',()=>output.close(),{once:true});}}),{headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'3'}})});
  const reader=(await cancelled.bridge(request())).body.getReader();await reader.read();await reader.cancel();
  assert.equal(cancelled.calls.find(c=>c[0]==='finish')[3],'cancelled');assert.equal(cancelled.calls.find(c=>c[0]==='finish').at(-1),false);
});
