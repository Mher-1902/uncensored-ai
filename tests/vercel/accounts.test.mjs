import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AccountError,accountControlEnabled,createAccountStore,databaseOptions} from '../../cloud/vercel-gateway/account-store.mjs';
import {createBridge} from '../../cloud/vercel-gateway/index.mjs';
import {createAppHandler} from '../../cloud/vercel-api/handler.mjs';

const user='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const workerId='33333333-3333-4333-8333-333333333333';
const receipt=(options,outcome='completed')=>({requestId:options.headers['X-Offscript-Request-ID'],workerId,workerStopped:true,outcome});
const env={PILOT_ACCOUNT_CONTROL:'true',SUPABASE_URL:'https://project.supabase.co',SAMSUNG_API_ORIGIN:'https://worker.test',SAMSUNG_GATEWAY_TOKEN:'t'.repeat(40)};
const request=(path='/api/chat',data={messages:[{role:'user',content:'Hello'}],maxTokens:256,mode:'fast'})=>new Request('https://app.test'+path,{
  method:path==='/api/account'?'GET':'POST',headers:{Authorization:'Bearer dummy','Content-Type':'application/json','X-Offscript-Client':'web'},...(path==='/api/account'?{}:{body:JSON.stringify(data)}),
});
const metadata={plan:'free',status:'active',eligibility:'eligible',policies:{published:true,termsVersion:'terms-v1',privacyVersion:'privacy-v1',accepted:true},usage:{requestsRemaining:9,deepRemaining:2,tokensRemaining:19000}};
const frame=(event)=>'data: '+JSON.stringify(event)+'\n\n';
const admission=args=>({state:'active',answerId:args[1],requestId:args[2],maxTokens:args[5]});
function fixture(extra={}) {
  const calls=[],lifetimes=[];
  const store={account:async(...args)=>{calls.push(['account',...args]);return metadata},accept:async(...args)=>{calls.push(['accept',...args]);return metadata},
    startAnswer:async(...args)=>{calls.push(['reserve',...args]);return admission(args)},
    continueAnswer:async(...args)=>{calls.push(['continue',...args]);return {state:'active',answerId:args[1],requestId:args[3],maxTokens:args[5]}},
    finishSegment:async(...args)=>{calls.push(['finish',...args]);return {state:args.at(-1)?'finished':'uncertain',outcome:args[4],answerId:args[1]}},
    cancelAnswer:async(...args)=>{calls.push(['cancelAnswer',...args]);return {state:'finished'}},...extra.store};
  const fetchImpl=async(url,options)=>{
    calls.push(['worker',url.pathname,options]);
    if(url.pathname==='/api/health')return Response.json({ready:true,protocol:extra.protocol??5,workerId});
    if(url.pathname==='/api/prepare')return Response.json({prepared:true,...JSON.parse(options.body)});
    if(url.pathname==='/api/cancel')return extra.cancelResponse?extra.cancelResponse(options):Response.json({control:{workerStopped:false}});
    if(extra.response)return extra.response(options);
    return new Response(frame({choices:[{delta:{content:'Hello'},finish_reason:'stop'}]})+frame({usage:{prompt_tokens:8,completion_tokens:2}})+frame({control:receipt(options)})+'data: [DONE]\n\n',{
      headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'5'},
    });
  };
  const bridge=createBridge({env:{...env,...extra.env},accountStore:store,verify:async authorization=>{if(authorization!=='Bearer dummy')throw Error();return user},fetchImpl,defer:promise=>lifetimes.push(promise)});
  return {calls,store,bridge,lifetimes};
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
  const f=fixture({store:{finishSegment:async(...args)=>{f.calls.push(['finish',...args]);await new Promise(resolve=>{finish=resolve});return {state:'finished',outcome:'completed',answerId:args[1]}}}});
  const response=await f.bridge(request());const result=response.text();let ended=false;void result.then(()=>{ended=true});
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ended,false);
  const reserve=f.calls.find(c=>c[0]==='reserve');assert.equal(reserve[1],user);assert.equal(reserve[4],workerId);assert.equal(reserve[5],'fast');assert.equal(reserve[6],256);
  assert.ok(f.calls.findIndex(c=>c[0]==='reserve')<f.calls.findIndex(c=>c[0]==='worker'&&c[1]==='/api/chat'));
  const settled=f.calls.find(c=>c[0]==='finish');assert.deepEqual(settled.slice(1),[user,reserve[2],reserve[3],workerId,'completed',8,2,'stop',true,true]);
  finish();const text=await result;assert.match(text,/\[DONE\]/);assert.doesNotMatch(text,/control|workerStopped/);
});

test('quota errors survive the public binding with approved wording and no database details',async()=>{
  const f=fixture({store:{startAnswer:async()=>{throw new AccountError('quota_exceeded')}}});
  const handler=createAppHandler('/api/chat',{env:{GATEWAY_URL:'https://internal.test'},fetchImpl:(url,options)=>f.bridge(new Request(url,options))});
  const result=await handler(request());assert.equal(result.status,429);assert.equal((await result.json()).code,'quota_exceeded');
  assert.equal(f.calls.some(c=>c[0]==='worker'&&c[1]==='/api/chat'),false);
});

test('old workers cannot admit a lease and unconfirmed completion retains an uncertain lease',async()=>{
  for(const protocol of [2,4]){const old=fixture({protocol});assert.equal((await old.bridge(request())).status,503);assert.equal(old.calls.some(c=>c[0]==='reserve'),false);}
  const broken=fixture({response:()=>new Response(frame({choices:[{delta:{content:'Partial'}}]})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'5'}})});
  await assert.rejects((await broken.bridge(request())).text(),/finalized/);
  assert.equal(broken.calls.find(c=>c[0]==='finish').at(-1),false);
});

test('continuation needs an owner-bound database receipt; the native model sees neither receipt nor answer ID',async()=>{
  const answerId='55555555-5555-4555-8555-555555555555',token='66666666-6666-4666-8666-666666666666';
  const payload={messages:[{role:'user',content:'Hello'},{role:'assistant',content:'Prefix '}],mode:'fast',maxTokens:256,continuation:true};
  const f=fixture({store:{continueAnswer:async(...args)=>{f.calls.push(['continue',...args]);return {state:'active',answerId,requestId:args[3],maxTokens:66}}}});
  for(const extra of [{},{answerId},{answerId,receipt:'bad'}])assert.equal((await f.bridge(request('/api/chat',{...payload,...extra}))).status,400);
  assert.equal(f.calls.length,0);
  const response=await f.bridge(request('/api/chat',{...payload,answerId,receipt:token}));
  const text=await response.text();assert.match(text,/\[DONE\]/);
  const admission=f.calls.find(call=>call[0]==='continue');assert.deepEqual(admission.slice(1,4),[user,answerId,token]);
  assert.equal(f.calls.some(call=>call[0]==='reserve'),false);
  const native=JSON.parse(f.calls.find(call=>call[0]==='worker'&&call[1]==='/api/chat')[2].body);
  assert.equal(native.maxTokens,66);assert.deepEqual(native.messages,payload.messages);assert.equal(native.answerId,undefined);assert.equal(native.receipt,undefined);
  const denied=fixture({store:{continueAnswer:async()=>{throw new AccountError('continuation_invalid')}}});
  assert.equal((await denied.bridge(request('/api/chat',{...payload,answerId,receipt:token}))).status,409);
  assert.equal(denied.calls.some(call=>call[0]==='worker'&&call[1]==='/api/chat'),false);
});

test('a continuation receipt is emitted only after the database settles a proven stopped segment',async()=>{
  let complete;const token='66666666-6666-4666-8666-666666666666';
  const f=fixture({response:options=>new Response(frame({choices:[{delta:{content:'Part'},finish_reason:'length'}]})+frame({usage:{prompt_tokens:8,completion_tokens:2}})+frame({control:receipt(options)})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'5'}}),
    store:{finishSegment:async(...args)=>{f.calls.push(['finish',...args]);await new Promise(resolve=>{complete=resolve});return {state:'waiting',answerId:args[1],receipt:token}}}});
  let received='';const result=(async()=>{const response=await f.bridge(request());for await(const chunk of response.body)received+=new TextDecoder().decode(chunk)})();
  while(!complete)await new Promise(resolve=>setImmediate(resolve));
  assert.match(received,/Part/);assert.doesNotMatch(received,new RegExp(token+'|\\[DONE\\]'));
  complete();await result;assert.match(received,new RegExp(token));assert.match(received,/\[DONE\]/);
});

test('invalid final usage cannot reuse an earlier valid count or falsely complete an answer',async()=>{
  const f=fixture({response:options=>new Response(frame({choices:[{delta:{content:'Part'},finish_reason:'stop'}]})+frame({usage:{prompt_tokens:8,completion_tokens:2}})+frame({usage:{prompt_tokens:8,completion_tokens:999999}})+frame({control:receipt(options)})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'5'}}),
    store:{finishSegment:async(...args)=>{f.calls.push(['finish',...args]);return {state:'finished',outcome:'failed',answerId:args[1]}}}});
  const text=await (await f.bridge(request())).text();assert.match(text,/Part/);assert.doesNotMatch(text,/\[DONE\]/);assert.match(text,/"error"/);
  assert.deepEqual(f.calls.find(call=>call[0]==='finish').slice(6,8),[null,null]);
});

test('public Stop uses the verified owner and returns no private worker identifiers',async()=>{
  const answerId='55555555-5555-4555-8555-555555555555';
  const f=fixture({store:{cancelAnswer:async(...args)=>{f.calls.push(['cancelAnswer',...args]);return {state:'active',requestId:other,workerId}}},
    cancelResponse:options=>Response.json({control:{...JSON.parse(options.body),workerStopped:true,outcome:'cancelled'}})});
  const handler=createAppHandler('/api/answer/cancel',{env:{GATEWAY_URL:'https://internal.test'},fetchImpl:(url,options)=>f.bridge(new Request(url,options))});
  const response=await handler(request('/api/answer/cancel',{answerId}));assert.deepEqual(await response.json(),{state:'finished'});
  assert.deepEqual(f.calls.find(call=>call[0]==='cancelAnswer'),['cancelAnswer',user,answerId]);
  const finished=f.calls.find(call=>call[0]==='finish');assert.deepEqual(finished.slice(1,6),[user,answerId,other,workerId,'cancelled']);assert.equal(finished.at(-1),true);
  assert.equal((await f.bridge(request('/api/answer/cancel',{answerId,userId:other}))).status,400);
  const missing=request('/api/answer/cancel',{answerId});missing.headers.delete('authorization');assert.equal((await f.bridge(missing)).status,401);
});

test('public Stop cannot release capacity using an unknown or stale worker acknowledgement',async()=>{
  const answerId='55555555-5555-4555-8555-555555555555';
  const f=fixture({store:{cancelAnswer:async()=>({state:'active',requestId:other,workerId})},cancelResponse:()=>Response.json({control:{requestId:other,workerId:user,workerStopped:true,outcome:'cancelled'}})});
  assert.deepEqual(await (await f.bridge(request('/api/answer/cancel',{answerId}))).json(),{state:'uncertain'});
  assert.equal(f.calls.find(call=>call[0]==='finish').at(-1),false);
  assert.equal((await fixture({env:{PILOT_ACCOUNT_CONTROL:'false'}}).bridge(request('/api/answer/cancel',{answerId}))).status,404);
});

test('failed database settlement withholds DONE even after the worker confirms cleanup',async()=>{
  const f=fixture({store:{finishSegment:async()=>{throw Error('private database detail')}}});
  await assert.rejects((await f.bridge(request())).text(),error=>!error.message.includes('private database detail'));
});

test('a confirmed pre-start worker rejection refunds admission, while a disconnect does not',async()=>{
  const rejected=fixture({response:options=>Response.json({error:'internal detail',control:receipt(options,'rejected')},{status:422,headers:{'X-Offscript-Protocol':'5'}})});
  const result=await rejected.bridge(request());assert.equal(result.status,422);assert.doesNotMatch(await result.text(),/internal detail/);
  assert.equal(rejected.calls.find(c=>c[0]==='finish')[5],'rejected');assert.equal(rejected.calls.find(c=>c[0]==='finish').at(-1),true);
  const cancelled=fixture({response:options=>new Response(new ReadableStream({start(output){output.enqueue(new TextEncoder().encode(frame({choices:[{delta:{content:'First'}}]})));options.signal.addEventListener('abort',()=>output.close(),{once:true});}}),{headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'5'}})});
  const reader=(await cancelled.bridge(request())).body.getReader();await reader.read();await reader.cancel();
  assert.equal(cancelled.calls.find(c=>c[0]==='finish')[5],'cancelled');assert.equal(cancelled.calls.find(c=>c[0]==='finish').at(-1),false);
});

test('browser cancellation settles only after a matching cleanup acknowledgement and keeps waitUntil alive',async()=>{
  let acknowledge,finish;const controller=new AbortController();
  const f=fixture({
    response:options=>new Response(new ReadableStream({start(output){
      output.enqueue(new TextEncoder().encode(frame({choices:[{delta:{content:'First'}}]})));
      options.signal.addEventListener('abort',()=>output.close(),{once:true});
    }}),{headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'5'}}),
    cancelResponse:async options=>{await new Promise(resolve=>{acknowledge=resolve});return Response.json({control:{...JSON.parse(options.body),workerStopped:true,outcome:'cancelled'}})},
    store:{finishSegment:async(...args)=>{f.calls.push(['finish',...args]);await new Promise(resolve=>{finish=resolve});return {state:'finished',outcome:'cancelled',answerId:args[1]}}},
  });
  const response=await f.bridge(new Request(request(),{signal:controller.signal}));
  const reader=response.body.getReader();await reader.read();
  let lifetimeEnded=false;void f.lifetimes[0].then(()=>{lifetimeEnded=true});
  controller.abort();
  while(!acknowledge)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.some(c=>c[0]==='finish'),false);assert.equal(lifetimeEnded,false);
  const cancel=f.calls.find(c=>c[0]==='worker'&&c[1]==='/api/cancel');assert.equal(cancel[2].signal.aborted,false);
  acknowledge();while(!finish)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(lifetimeEnded,false);assert.equal(f.calls.find(c=>c[0]==='finish').at(-1),true);
  finish();await f.lifetimes[0];await reader.cancel();assert.equal(lifetimeEnded,true);
  assert.equal(f.calls.filter(c=>c[0]==='finish').length,1);
});

test('cancellation racing the database reservation refunds only before any worker dispatch',async()=>{
  let admit;const controller=new AbortController();
  const f=fixture({store:{startAnswer:async(...args)=>{f.calls.push(['reserve',...args]);await new Promise(resolve=>{admit=resolve});return admission(args)}}});
  const result=f.bridge(new Request(request(),{signal:controller.signal}));
  while(!admit)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.lifetimes.length,1);controller.abort();admit();
  assert.equal((await result).status,503);await f.lifetimes[0];
  assert.equal(f.calls.some(c=>c[0]==='worker'&&c[1]==='/api/chat'),false);
  const settled=f.calls.find(c=>c[0]==='finish');assert.equal(settled[5],'rejected');assert.equal(settled.at(-1),true);
});

test('a stale or mismatched cleanup receipt cannot release the database lease',async()=>{
  const f=fixture({response:()=>new Response(frame({control:{requestId:other,workerId,workerStopped:true,outcome:'completed'}})+'data: [DONE]\n\n',{
    headers:{'Content-Type':'text/event-stream','X-Offscript-Protocol':'5'},
  }),cancelResponse:()=>Response.json({control:{requestId:other,workerId,workerStopped:true,outcome:'cancelled'}})});
  await assert.rejects((await f.bridge(request())).text(),/finalized/);await f.lifetimes[0];
  assert.equal(f.calls.find(c=>c[0]==='finish').at(-1),false);
});
