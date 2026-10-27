import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createGateway,validateRequest} from '../server/index.mjs';
import {REPLY_GUIDANCE} from '../server/llama-engine.mjs';
import {readEvents} from '../src/stream.ts';

const input={messages:[{role:'user',content:'Hello'}],maxTokens:256,reasoned:false};
const headers={'Content-Type':'application/json','X-Offscript-Client':'web',Origin:'https://offscript.test'};
function fixture(options={}){
  const calls=[],controls=[];let busy=0,maxBusy=0;
  const fetchImpl=async(url,opts={})=>{
    const path=new URL(url).pathname;calls.push({path,body:opts.body?JSON.parse(opts.body):null});
    if(path.startsWith('/slots/'))return new Response('{}',{status:options.failErase?503:200});
    if(path==='/health')return new Response('{}',{status:options.offline?503:200});
    if(path==='/apply-template')return Response.json({prompt:'hello'});
    if(path==='/tokenize')return Response.json({tokens:Array(options.long?4090:options.tokens??8).fill(1)});
    if(path==='/v1/chat/completions'){
      busy++;maxBusy=Math.max(busy,maxBusy);
      const encoder=new TextEncoder();let finished=false;
      const body=new ReadableStream({start(controller){
        const close=()=>{if(finished)return;finished=true;busy--;try{controller.close()}catch{}};
        const write=()=>{if(finished)return;controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello 🌍"}}]}\n\ndata: {"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n'));close()};
        controls.push({write,close});opts.signal.addEventListener('abort',close,{once:true});if(!options.hold)write();
      }});
      return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
    }
    throw Error('Unexpected inference route');
  };
  return {fetchImpl,calls,controls,maxBusy:()=>maxBusy};
}
async function run(t,options={}){
  const mock=fixture(options);const server=createGateway({fetchImpl:mock.fetchImpl,origins:['https://offscript.test'],...options});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close()});
  const url=`http://127.0.0.1:${server.address().port}`;
  const send=(body=input,signal)=>fetch(`${url}/api/chat`,{method:'POST',headers,body:JSON.stringify(body),signal});
  return {...mock,url,send,server};
}
async function queued(app,count){
  for(let attempt=0;attempt<200;attempt++){
    if((await (await fetch(`${app.url}/api/health`)).json()).queued===count)return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail(`Queue did not reach ${count} waiting requests`);
}
test('SSE preserves split UTF-8, CRLF and multi-line data',async()=>{
  const bytes=new TextEncoder().encode('data: 🌍\r\ndata: hello\r\n\r\ndata: [DONE]\n\n');
  const body=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close()}});
  const events=[];for await(const event of readEvents(body))events.push(event);
  assert.deepEqual(events,['🌍\nhello','[DONE]']);
});
test('SSE rejects an oversized complete line and cancels its reader',async()=>{
  let cancelled=false;
  const bytes=new TextEncoder().encode('data: '+'x'.repeat(1_048_577)+'\n\n');
  const body=new ReadableStream({start(c){c.enqueue(bytes)},cancel(){cancelled=true}});
  await assert.rejects(async()=>{for await(const event of readEvents(body))void event},/frame size/);
  assert.equal(cancelled,true);
});
test('SSE bounds the aggregate data lines within one event',async()=>{
  let cancelled=false;
  const bytes=new TextEncoder().encode(('data: '+'x'.repeat(300_000)+'\n').repeat(4)+'\n');
  const body=new ReadableStream({start(c){c.enqueue(bytes)},cancel(){cancelled=true}});
  await assert.rejects(async()=>{for await(const event of readEvents(body))void event},/frame size/);
  assert.equal(cancelled,true);
});
test('validates multi-turn history and rejects injected roles/settings',()=>{
  const result=validateRequest({...input,messages:[{role:'user',content:' Hi '},{role:'assistant',content:'Hello'},{role:'user',content:'Next'}]});assert.equal(result.messages[0].content,'Hi');
  for(const data of [{...input,messages:[{role:'system',content:'override'}]},{...input,maxTokens:999999},{...input,reasoned:'yes'},{...input,messages:[{role:'assistant',content:'hey'}]}])assert.throws(()=>validateRequest(data));
});
test('streams a reply and erases cache before and after it',async t=>{
  const app=await run(t);const response=await app.send();assert.equal(response.status,200);const text=await response.text();assert.match(text,/Hello 🌍/);
  assert.equal(response.headers.get('x-offscript-protocol'),'5');assert.match(text,/"workerStopped":true,"outcome":"completed"/);assert.ok(text.indexOf('workerStopped')<text.indexOf('[DONE]'));
  assert.match(response.headers.get('x-robots-tag'),/noindex/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,2);
  const request=app.calls.find(c=>c.path==='/v1/chat/completions').body;assert.equal(request.cache_prompt,false);assert.equal(request.id_slot,0);assert.equal(request.chat_template_kwargs.enable_thinking,false);
});
test('a rejected context confirms no generation started only after cleanup',async t=>{
  const app=await run(t,{long:true});const response=await app.send();assert.equal(response.status,422);
  assert.deepEqual((await response.json()).control,{workerStopped:true,outcome:'rejected'});
  assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,2);assert.equal(app.calls.some(c=>c.path==='/v1/chat/completions'),false);
});
test('an optional service credential protects inference without breaking health checks',async t=>{
  const accessToken='t'.repeat(40);
  assert.throws(()=>createGateway({accessToken:'short'}));
  const app=await run(t,{accessToken});
  assert.equal((await fetch(`${app.url}/api/health`)).status,200);
  assert.equal((await app.send()).status,401);
  assert.equal(app.calls.filter(c=>c.path==='/v1/chat/completions').length,0);
  assert.equal((await fetch(`${app.url}/api/chat`,{method:'POST',headers:{...headers,Authorization:`Bearer ${'x'.repeat(40)}`},body:JSON.stringify(input)})).status,401);
  const accepted=await fetch(`${app.url}/api/chat`,{method:'POST',headers:{...headers,Authorization:`Bearer ${accessToken}`},body:JSON.stringify(input)});
  assert.equal(accepted.status,200);assert.match(await accepted.text(),/Hello/);
});
test('the default single-worker queue rejects a third request and completes the admitted pair',{timeout:5000},async t=>{
  const app=await run(t,{hold:true});const first=app.send();
  while(!app.controls.length)await new Promise(resolve=>setTimeout(resolve,5));
  const second=app.send();await queued(app,1);
  const rejected=await app.send();assert.equal(rejected.status,503);
  assert.equal(rejected.headers.get('x-offscript-protocol'),'5');
  assert.deepEqual(await rejected.json(),{error:'The model is busy. Please try again in a moment.',code:'model_busy',control:{workerStopped:true,outcome:'rejected'}});
  assert.equal(app.controls.length,1);await queued(app,1);
  app.controls[0].write();assert.match(await (await first).text(),/Hello 🌍[\s\S]*\[DONE\]/);
  while(app.controls.length<2)await new Promise(resolve=>setTimeout(resolve,5));
  app.controls[1].write();assert.match(await (await second).text(),/Hello 🌍[\s\S]*\[DONE\]/);
  assert.equal(app.maxBusy(),1);assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,4);await queued(app,0);
});
test('a waiting request times out without starting inference and releases its queue place',{timeout:5000},async t=>{
  const app=await run(t,{hold:true,queueTimeout:500});const first=app.send();
  while(!app.controls.length)await new Promise(resolve=>setTimeout(resolve,5));
  const timedOut=app.send();await queued(app,1);
  const rejected=await timedOut;assert.equal(rejected.status,503);assert.equal((await rejected.json()).code,'model_busy');
  await queued(app,0);assert.equal(app.controls.length,1);
  app.controls[0].write();assert.match(await (await first).text(),/\[DONE\]/);
  const next=app.send();while(app.controls.length<2)await new Promise(resolve=>setTimeout(resolve,5));
  app.controls[1].write();assert.match(await (await next).text(),/Hello 🌍/);
  assert.equal(app.controls.length,2);assert.equal(app.maxBusy(),1);
});
test('an automatic continuation outlasts the new-question wait limit behind an admitted question',{timeout:5000},async t=>{
  const app=await run(t,{hold:true,queueTimeout:500});const first=app.send();
  while(!app.controls.length)await new Promise(resolve=>setTimeout(resolve,5));
  const second=app.send();await queued(app,1);
  app.controls[0].write();assert.match(await (await first).text(),/Hello 🌍[\s\S]*\[DONE\]/);
  while(app.controls.length<2)await new Promise(resolve=>setTimeout(resolve,5));
  const continuation=app.send({...input,continuation:true,messages:[...input.messages,{role:'assistant',content:'Hello 🌍'}]});
  await queued(app,1);
  // Continuations count towards the new-work bound, so another question cannot pile ahead.
  const rejected=await app.send();assert.equal(rejected.status,503);assert.equal((await rejected.json()).code,'model_busy');
  await new Promise(resolve=>setTimeout(resolve,550));
  await queued(app,1);assert.equal(app.controls.length,2);
  app.controls[1].write();assert.match(await (await second).text(),/Hello 🌍[\s\S]*\[DONE\]/);
  while(app.controls.length<3)await new Promise(resolve=>setTimeout(resolve,5));
  app.controls[2].write();const response=await continuation;assert.equal(response.status,200);assert.match(await response.text(),/Hello 🌍[\s\S]*\[DONE\]/);
  assert.equal(app.controls.length,3);assert.equal(app.maxBusy(),1);assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,6);await queued(app,0);
});
test('Stop while queued removes the request and it never dispatches after the active reply',{timeout:5000},async t=>{
  const app=await run(t,{hold:true});const first=app.send();
  while(!app.controls.length)await new Promise(resolve=>setTimeout(resolve,5));
  const controller=new AbortController();const second=app.send(input,controller.signal);
  const cancelled=assert.rejects(second,error=>error.name==='AbortError');await queued(app,1);
  controller.abort();await cancelled;await queued(app,0);assert.equal(app.controls.length,1);
  app.controls[0].write();assert.match(await (await first).text(),/\[DONE\]/);
  const next=app.send();while(app.controls.length<2)await new Promise(resolve=>setTimeout(resolve,5));
  app.controls[1].write();assert.match(await (await next).text(),/Hello 🌍/);
  assert.equal(app.calls.filter(c=>c.path==='/v1/chat/completions').length,2);
  assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,4);assert.equal(app.maxBusy(),1);
});
test('unavailable health, oversized context and forbidden origin fail honestly',async t=>{
  const app=await run(t,{offline:true,long:true});assert.equal((await fetch(`${app.url}/api/health`)).status,503);assert.equal((await app.send()).status,422);
  const rejected=await fetch(`${app.url}/api/chat`,{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify(input)});assert.equal(rejected.status,403);
  assert.equal(app.calls.filter(c=>c.path==='/v1/chat/completions').length,0);
});
test('public gateway accepts its configured HTTPS origin without trusting arbitrary hosts',async t=>{
  for(const apiOrigin of ['http://model.test','https://model.test/','https://user:password@model.test','https://model.test/api'])assert.throws(()=>createGateway({apiOrigin}));
  const app=await run(t,{origins:undefined,apiOrigin:'https://model.test'});
  const response=await fetch(`${app.url}/api/health`,{headers:{Origin:'https://model.test'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),'https://model.test');
  assert.equal((await fetch(`${app.url}/api/health`,{headers:{Origin:'https://other.test',Host:'model.test'}})).status,403);
});
test('failed cache cleanup prevents inference',async t=>{
  const app=await run(t,{failErase:true});assert.equal((await app.send()).status,503);assert.equal((await app.send()).status,503);assert.equal(app.calls.filter(c=>c.path==='/v1/chat/completions').length,0);
});
test('leaving cancels upstream inference and clears slot',async t=>{
  const app=await run(t,{hold:true});const ctrl=new AbortController();const promise=app.send(input,ctrl.signal);
  while(!app.controls.length)await new Promise(resolve=>setTimeout(resolve,5));ctrl.abort();await assert.rejects(promise);await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,2);
});
test('generation abort releases a slot waiting for downstream drain',{timeout:2000},async t=>{
  const app=await run(t,{generationTimeout:40});let stalled=false;
  // Model one unwritable response; no socket saturation or real inference.
  app.server.prependListener('request',(req,res)=>{
    if(req.url!=='/api/chat'||stalled)return;
    const write=res.write.bind(res);
    res.write=(...args)=>{const result=write(...args);if(String(args[0]).includes('Hello 🌍')){stalled=true;return false}return result};
  });
  const response=await app.send();assert.match(await response.text(),/took too long/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stalled,true);assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,2);
  assert.equal((await (await fetch(`${app.url}/api/health`)).json()).busy,false);
  const next=await app.send();assert.equal(next.status,200);assert.match(await next.text(),/Hello 🌍/);
});
test('unknown routes return branded HTTP 404, not the chat app',async t=>{
  const app=await run(t);const missing=await fetch(`${app.url}/missing-page`);assert.equal(missing.status,404);assert.match(await missing.text(),/This page went offscript/);
  assert.match(missing.headers.get('x-robots-tag'),/noindex/);
  const home=await fetch(`${app.url}/`);assert.equal(home.status,200);const html=await home.text();assert.match(html,/Ask\. Think\. Disappear/);assert.match(html,/rel="canonical"/);
  assert.equal((await fetch(`${app.url}/slots`)).status,404);assert.equal((await fetch(`${app.url}/api/anything`)).status,404);
});
test('canonical aliases redirect and operational routes stay out of search indexes',async t=>{
  const app=await run(t);
  const alias=await fetch(`${app.url}/index.html?source=bookmark`,{redirect:'manual'});
  assert.equal(alias.status,308);assert.equal(alias.headers.get('location'),'/?source=bookmark');
  const home=await fetch(`${app.url}/`);assert.equal(home.headers.get('x-robots-tag'),null);
  for(const route of ['/config.json','/api/health','/api/missing','/404.html']){
    const response=await fetch(app.url+route);assert.match(response.headers.get('x-robots-tag'),/noindex/);
  }
});
test('invalid client and JSON envelopes never reach inference',async t=>{
  const app=await run(t);
  const request=(body,extra={})=>fetch(`${app.url}/api/chat`,{method:'POST',headers:{...headers,...extra},body,signal:AbortSignal.timeout(5000)});
  assert.equal((await request(JSON.stringify(input),{'X-Offscript-Client':''})).status,403);
  assert.equal((await request(JSON.stringify(input),{'Content-Type':'text/plain'})).status,415);
  assert.equal((await request(JSON.stringify(input),{'Content-Type':'application/json-invalid'})).status,415);
  assert.equal((await request('{')).status,400);
  assert.equal((await request(JSON.stringify({...input,maxTokens:64}))).status,400);
  assert.equal(app.calls.length,0);
});
test('only a credential-authenticated tracked request can use a final clamped token allowance',async t=>{
  const accessToken='t'.repeat(40),app=await run(t,{accessToken});
  const health=await (await fetch(`${app.url}/api/health`)).json();assert.equal(health.protocol,5);
  const body={...input,maxTokens:66,continuation:true,messages:[{role:'user',content:'Hello'},{role:'assistant',content:'Prefix '}]};
  const tracking={'X-Offscript-Request-ID':'11111111-1111-4111-8111-111111111111','X-Offscript-Worker-ID':health.workerId,'X-Offscript-Request-Deadline':String(Date.now()+10000)};
  const send=extra=>fetch(`${app.url}/api/chat`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await send(tracking)).status,401);
  assert.equal((await send({Authorization:`Bearer ${accessToken}`})).status,400);
  const response=await send({...tracking,Authorization:`Bearer ${accessToken}`});assert.equal(response.status,200);await response.text();
  assert.equal(app.calls.find(call=>call.path==='/v1/chat/completions').body.max_tokens,66);
  for(const maxTokens of [0,1025,2.5,'66'])assert.throws(()=>validateRequest({...body,maxTokens},{allowBoundedTokens:true}));
});
test('oversized JSON receives a bounded rejection before inference',async t=>{
  const app=await run(t);
  for(const size of [65536,524288]){
    const response=await app.send({...input,messages:[{role:'user',content:'x'.repeat(size)}]},AbortSignal.timeout(5000));
    assert.equal(response.status,413);
    assert.match(response.headers.get('x-robots-tag'),/noindex/);
  }
  assert.equal(app.calls.length,0);
});

test('explicit modes and the transition field agree before inference',async t=>{
  assert.equal(validateRequest({...input,reasoned:undefined,mode:'fast'}).mode,'fast');
  assert.equal(validateRequest({...input,reasoned:undefined,mode:'deep'}).mode,'deep');
  assert.equal(validateRequest({...input,reasoned:true}).mode,'deep');
  for(const settings of [{mode:'research'},{mode:'other'},{mode:'deep',reasoned:false},{mode:'fast',reasoned:true}]) {
    assert.throws(()=>validateRequest({...input,...settings}),/reply settings/);
  }
  const app=await run(t);
  const response=await app.send({...input,reasoned:undefined,mode:'deep'});
  assert.equal(response.status,200);await response.text();
  const request=app.calls.find(call=>call.path==='/v1/chat/completions').body;
  assert.equal(request.chat_template_kwargs.enable_thinking,true);
  assert.equal(request.max_tokens,512);
  assert.equal(request.reasoning_budget_tokens,256);
});

test('completion is not acknowledged until model state disposal finishes',async t=>{
  let disposals=0,finishCleanup;
  const cleanup=new Promise(resolve=>{finishCleanup=resolve});
  const engine={ready:async()=>true,prepare:async()=>({}),
    generate:async()=>new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n'),
    dispose:async()=>{if(++disposals===2)await cleanup;return true}};
  const app=await run(t,{engine});
  const response=await app.send();let ended=false;
  const text=response.text().then(value=>{ended=true;return value});
  while(disposals<2)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ended,false);
  finishCleanup();assert.match(await text,/Answer[\s\S]*\[DONE\]/);
});

test('failed final disposal withholds DONE and marks the worker unavailable',async t=>{
  let disposals=0;
  const engine={ready:async()=>true,prepare:async()=>({}),
    generate:async()=>new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n'),
    dispose:async()=>++disposals===1};
  const app=await run(t,{engine});
  const response=await app.send();const text=await response.text();
  assert.match(text,/needs to restart/);assert.doesNotMatch(text,/\[DONE\]/);
  assert.equal((await fetch(`${app.url}/api/health`)).status,503);
});

test('adapter rejects credential-bearing, non-loopback and non-HTTP listeners',()=>{
  for(const inference of ['https://127.0.0.1:8081','http://model.internal:8081','http://u:p@localhost:8081','file:///tmp/model','http://localhost:8081/private']) {
    assert.throws(()=>createGateway({inference}),/loopback HTTP origin/);
  }
});

test('private cancellation waits for slot cleanup and cannot stop an unknown worker request',async t=>{
  const accessToken='t'.repeat(40);let releaseCleanup,disposals=0,generations=0;
  const engine={ready:async()=>true,prepare:async input=>input,
    generate:async(_input,signal)=>{
      generations++;
      return new Response(new ReadableStream({start(output){
        output.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"First"}}]}\n\n'));
        signal.addEventListener('abort',()=>output.close(),{once:true});
      }}));
    },dispose:async()=>{if(++disposals===2)await new Promise(resolve=>{releaseCleanup=resolve});return true}};
  const app=await run(t,{engine,accessToken});
  const workerId=(await (await fetch(`${app.url}/api/health`)).json()).workerId;
  const requestId='11111111-1111-4111-8111-111111111111';
  const tracking={'X-Offscript-Request-ID':requestId,'X-Offscript-Worker-ID':workerId,'X-Offscript-Request-Deadline':String(Date.now()+10000)};
  const send=()=>fetch(`${app.url}/api/chat`,{method:'POST',headers:{...headers,...tracking,Authorization:`Bearer ${accessToken}`},body:JSON.stringify(input)});
  const cancel=(data={requestId,workerId},authorized=true)=>fetch(`${app.url}/api/cancel`,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:`Bearer ${accessToken}`}:{})},body:JSON.stringify(data)});
  const response=await send();const reader=response.body.getReader();await reader.read();
  assert.equal((await cancel(undefined,false)).status,401);
  assert.equal((await (await cancel({requestId,workerId:'22222222-2222-4222-8222-222222222222'})).json()).control.workerStopped,false);
  let acknowledged=false;const stopping=cancel().then(value=>{acknowledged=true;return value});
  while(!releaseCleanup)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(acknowledged,false);
  releaseCleanup();const stopped=await (await stopping).json();
  assert.deepEqual(stopped.control,{requestId,workerId,workerStopped:true,outcome:'cancelled'});
  assert.equal((await send()).status,409);assert.equal(generations,1);
  assert.equal((await (await fetch(`${app.url}/api/health`)).json()).busy,false);
  await reader.cancel();
  assert.equal((await cancel({...stopped.control,workerStopped:true})).status,400);
});

test('a disconnected tracked stream retains a cancelled receipt rather than reporting completion',async t=>{
  const accessToken='t'.repeat(40),app=await run(t,{hold:true,accessToken});
  const workerId=(await (await fetch(`${app.url}/api/health`)).json()).workerId;
  const requestId='11111111-1111-4111-8111-111111111111',controller=new AbortController();
  const pending=fetch(`${app.url}/api/chat`,{method:'POST',signal:controller.signal,
    headers:{...headers,Authorization:`Bearer ${accessToken}`,'X-Offscript-Request-ID':requestId,'X-Offscript-Worker-ID':workerId,'X-Offscript-Request-Deadline':String(Date.now()+10000)},body:JSON.stringify(input)});
  while(!app.controls.length)await new Promise(resolve=>setTimeout(resolve,5));
  controller.abort();await assert.rejects(pending);
  const response=await fetch(`${app.url}/api/cancel`,{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({requestId,workerId})});
  assert.equal((await response.json()).control.outcome,'cancelled');
  assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,2);
});

test('continuation requires an assistant prefix and preserves its exact whitespace',()=>{
  const prefix='Code:\n```js\n  ';
  const data={...input,continuation:true,messages:[{role:'user',content:'Code?'},{role:'assistant',content:prefix}]};
  assert.equal(validateRequest(data).messages[1].content,prefix);
  for(const value of [{...data,continuation:'yes'},{...data,continuation:false},{...data,messages:input.messages},{...data,mode:'deep',reasoned:true}])assert.throws(()=>validateRequest(value));
});
test('template accounting and generation use the same assistant continuation contract',async t=>{
  const app=await run(t,{tokens:4000});
  const messages=[{role:'user',content:'Code?'},{role:'assistant',content:'Answer starts  '}];
  const response=await app.send({...input,messages,continuation:true});
  assert.equal(response.status,200);await response.text();
  const template=app.calls.find(c=>c.path==='/apply-template').body;
  const generation=app.calls.find(c=>c.path==='/v1/chat/completions').body;
  for(const body of [template,generation]){
    assert.deepEqual(body.messages,[{role:'system',content:REPLY_GUIDANCE},...messages]);
    assert.equal(body.continue_final_message,'content');assert.equal(body.add_generation_prompt,false);
    assert.equal(body.chat_template_kwargs.enable_thinking,false);
  }
  assert.equal(generation.max_tokens,96);assert.equal(generation.reasoning_budget_tokens,undefined);
});
