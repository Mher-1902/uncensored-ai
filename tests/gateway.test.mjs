import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createGateway,validateRequest} from '../server/index.mjs';
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
    if(path==='/tokenize')return Response.json({tokens:Array(options.long?4090:8).fill(1)});
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
  return {...mock,url,send};
}
test('SSE preserves split UTF-8, CRLF and multi-line data',async()=>{
  const bytes=new TextEncoder().encode('data: 🌍\r\ndata: hello\r\n\r\ndata: [DONE]\n\n');
  const body=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close()}});
  const events=[];for await(const event of readEvents(body))events.push(event);
  assert.deepEqual(events,['🌍\nhello','[DONE]']);
});
test('validates multi-turn history and rejects injected roles/settings',()=>{
  const result=validateRequest({...input,messages:[{role:'user',content:' Hi '},{role:'assistant',content:'Hello'},{role:'user',content:'Next'}]});assert.equal(result.messages[0].content,'Hi');
  for(const data of [{...input,messages:[{role:'system',content:'override'}]},{...input,maxTokens:999999},{...input,reasoned:'yes'},{...input,messages:[{role:'assistant',content:'hey'}]}])assert.throws(()=>validateRequest(data));
});
test('streams a reply and erases cache before and after it',async t=>{
  const app=await run(t);const response=await app.send();assert.equal(response.status,200);assert.match(await response.text(),/Hello 🌍/);
  assert.match(response.headers.get('x-robots-tag'),/noindex/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,2);
  const request=app.calls.find(c=>c.path==='/v1/chat/completions').body;assert.equal(request.cache_prompt,false);assert.equal(request.id_slot,0);assert.equal(request.chat_template_kwargs.enable_thinking,false);
});
test('concurrent callers share one inference slot',async t=>{
  const app=await run(t);const responses=await Promise.all(Array.from({length:10},async()=>{const r=await app.send();return r.text()}));assert.equal(responses.length,10);assert.equal(app.maxBusy(),1);assert.equal(app.calls.filter(c=>c.path==='/slots/0').length,20);
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
