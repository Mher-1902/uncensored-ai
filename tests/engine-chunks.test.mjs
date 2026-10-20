import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createLlamaEngine} from '../server/llama-engine.mjs';
import {createGateway} from '../server/index.mjs';
import {readEvents} from '../src/stream.ts';

function fixture(chunks,options={}) {
  const calls=[];let templates=0,generations=0;
  function render(messages) {
    return messages.map((m,i)=>m.role==='user'?`U:${m.content}\nA:`:m.content+(i<messages.length-1?'\nEND\n':'')).join('');
  }
  const fetchImpl=async(url,settings={})=>{
    const path=new URL(url).pathname,body=settings.body&&JSON.parse(settings.body);
    calls.push({path,body});
    if(path==='/health'||path.startsWith('/slots/'))return Response.json({});
    if(path==='/apply-template')return Response.json({prompt:render(body.messages)+(++templates>1&&options.mismatch?'changed':'')});
    if(path==='/tokenize')return Response.json({tokens:Array(10).fill(1)});
    if(path==='/v1/chat/completions') {
      const chunk=chunks[generations++];assert.ok(chunk,'Unexpected generation');
      const choice={delta:{content:chunk.text},finish_reason:chunk.finish??'length'};
      const usage={prompt_tokens:generations===1?10:99,completion_tokens:chunk.tokens??body.max_tokens,...chunk.usage};
      const stream=`data: ${JSON.stringify({choices:[choice]})}\n\ndata: ${JSON.stringify({usage})}\n\n${chunk.noDone?'':'data: [DONE]\n\n'}`;
      return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
    }
    throw Error('Unexpected engine route');
  };
  return {calls,engine:createLlamaEngine({origin:'http://127.0.0.1:8081',fetchImpl,chunkTokens:options.chunkTokens??2})};
}
const input={messages:[{role:'user',content:'Code?'}],maxTokens:4,mode:'fast'};
async function answer(f,inputValue=input,signal=new AbortController().signal) {
  const prepared=await f.engine.prepare(inputValue,signal);
  const response=await f.engine.generate(prepared,signal),events=[];
  for await(const raw of readEvents(response.body))events.push(raw==='[DONE]'?raw:JSON.parse(raw));
  return events;
}
const generations=f=>f.calls.filter(c=>c.path==='/v1/chat/completions').map(c=>c.body);

test('one request reuses only its exact unfinished prefix and aggregates unique usage',async()=>{
  const f=fixture([{text:'Code:\n  '},{text:'done',finish:'stop',tokens:1}]);
  const events=await answer(f),requests=generations(f);
  assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.max_tokens),[2,2]);
  assert.ok(requests.every(r=>r.cache_prompt===true&&r.id_slot===0&&r.chat_template_kwargs.enable_thinking===false));
  assert.deepEqual(requests[1].messages,[...input.messages,{role:'assistant',content:'Code:\n  '}]);
  assert.equal(requests[1].continue_final_message,'content');assert.equal(requests[1].add_generation_prompt,false);
  assert.deepEqual(events.at(-2),{choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}});
  assert.equal(events.at(-1),'[DONE]');
  assert.equal(events.filter(e=>e.choices?.[0]?.finish_reason==='length').length,0);
});

test('a clamped final chunk stays within the original budget and preserves an existing prefix',async()=>{
  const f=fixture([{text:'x'},{text:'y'}]);
  const events=await answer(f,{...input,maxTokens:3,continuation:true,messages:[...input.messages,{role:'assistant',content:'Prefix  '}]});
  const requests=generations(f);
  assert.deepEqual(requests.map(r=>r.max_tokens),[2,1]);
  assert.equal(requests[1].messages.at(-1).content,'Prefix  x');
  assert.equal(events.at(-2).usage.completion_tokens,3);assert.equal(events.at(-2).choices[0].finish_reason,'length');
});

test('a natural stop never starts another chunk',async()=>{
  const f=fixture([{text:'Done.',finish:'stop',tokens:1}]);
  assert.equal((await answer(f)).at(-2).choices[0].finish_reason,'stop');assert.equal(generations(f).length,1);
});

test('changed templates, invalid usage and incomplete streams cannot continue or report DONE',async()=>{
  for(const [chunk,options] of [[{text:'first'},{mismatch:true}],[{text:'first',usage:{completion_tokens:3}},{}],[{text:'first',noDone:true},{}],[{text:'',tokens:0},{}]]) {
    const f=fixture([chunk],options),seen=[];
    const response=await f.engine.generate(await f.engine.prepare(input,new AbortController().signal),new AbortController().signal);
    await assert.rejects(async()=>{for await(const raw of readEvents(response.body))seen.push(raw)});
    assert.equal(generations(f).length,1);assert.ok(!seen.includes('[DONE]'));
  }
});

test('Stop between internal chunks does not start another generation',async()=>{
  const f=fixture([{text:'first'},{text:'unexpected'}]),controller=new AbortController();
  const response=await f.engine.generate(await f.engine.prepare(input,controller.signal),controller.signal);
  const iterator=readEvents(response.body)[Symbol.asyncIterator]();
  assert.match((await iterator.next()).value,/first/);controller.abort();
  await assert.rejects(iterator.next());assert.equal(generations(f).length,1);
});

test('Deep Think keeps its original hidden-thinking budget and cleanup contract',async()=>{
  const f=fixture([{text:'Answer',finish:'stop',tokens:1}]);
  await answer(f,{...input,maxTokens:256,mode:'deep'});
  const [request]=generations(f);assert.equal(request.max_tokens,512);assert.equal(request.reasoning_budget_tokens,256);assert.equal(request.cache_prompt,false);
});

test('gateway keeps the slot exclusive across chunks and clears it before another request',async t=>{
  const f=fixture([{text:'A'},{text:'B',tokens:1,finish:'stop'},{text:'C',tokens:1,finish:'stop'}],{chunkTokens:256});
  const server=createGateway({engine:f.engine,origins:['https://offscript.test']});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close()});
  const send=()=>fetch(`http://127.0.0.1:${server.address().port}/api/chat`,{method:'POST',headers:{Origin:'https://offscript.test','X-Offscript-Client':'web','Content-Type':'application/json'},body:JSON.stringify({...input,maxTokens:512})});
  const first=await send(),text=await first.text();assert.match(text,/workerStopped":true/);assert.match(text,/\[DONE\]/);
  assert.equal(first.headers.get('x-offscript-protocol'),'5');
  await (await send()).text();
  assert.deepEqual(f.calls.filter(c=>c.path.startsWith('/slots/')||c.path==='/v1/chat/completions').map(c=>c.path),['/slots/0','/v1/chat/completions','/v1/chat/completions','/slots/0','/slots/0','/v1/chat/completions','/slots/0']);
});
