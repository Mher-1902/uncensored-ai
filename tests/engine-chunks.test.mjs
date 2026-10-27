import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createLlamaEngine,REPLY_GUIDANCE} from '../server/llama-engine.mjs';
import {createGateway} from '../server/index.mjs';
import {readEvents} from '../src/stream.ts';

function fixture(chunks,options={}) {
  const calls=[],controls=[];let templates=0,generations=0;
  function render(messages) {
    return messages.map((m,i)=>m.role==='user'?`U:${m.content}\nA:`:m.content+(i<messages.length-1?'\nEND\n':'')).join('');
  }
  const fetchImpl=async(url,settings={})=>{
    const path=new URL(url).pathname,body=settings.body&&JSON.parse(settings.body);
    calls.push({path,body});
    if(path==='/health'||path.startsWith('/slots/'))return Response.json({});
    if(path==='/apply-template')return Response.json({prompt:render(body.messages)+(++templates>1&&options.mismatch?'changed':'')});
    if(path==='/tokenize')return Response.json({tokens:Array(options.promptTokens??10).fill(1)});
    if(path==='/v1/chat/completions') {
      const chunk=chunks[generations++];assert.ok(chunk,'Unexpected generation');
      const choice={delta:{content:chunk.text},finish_reason:chunk.finish??'length'};
      const usage={prompt_tokens:generations===1?10:99,completion_tokens:chunk.tokens??body.max_tokens,...chunk.usage};
      const stream=`data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\ndata: ${JSON.stringify({choices:[choice]})}\n\ndata: ${JSON.stringify({usage})}\n\n${chunk.noDone?'':'data: [DONE]\n\n'}`;
      let closed=false,output;
      const close=()=>{if(closed)return;closed=true;settings.signal.removeEventListener('abort',close);try{output.close()}catch{}};
      const bodyStream=new ReadableStream({start(controller){
        output=controller;settings.signal.addEventListener('abort',close,{once:true});
        const write=()=>{if(closed)return;output.enqueue(new TextEncoder().encode(stream));close()};
        controls.push(write);
        if(settings.signal.aborted)close();else if(generations!==options.holdGeneration)write();
      },cancel:close});
      return new Response(bodyStream,{headers:{'Content-Type':'text/event-stream'}});
    }
    throw Error('Unexpected engine route');
  };
  return {calls,controls,engine:createLlamaEngine({origin:'http://127.0.0.1:8081',fetchImpl,chunkTokens:options.chunkTokens??2})};
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
  assert.deepEqual(requests[1].messages,[{role:'system',content:REPLY_GUIDANCE},...input.messages,{role:'assistant',content:'Code:\n  '}]);
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

test('server guidance is accounted once and remains identical across preparation and continuation',async()=>{
  const original=structuredClone(input),f=fixture([{text:'One '},{text:'answer.',finish:'stop',tokens:1}]);
  await answer(f);
  assert.deepEqual(input,original);
  const templates=f.calls.filter(c=>c.path==='/apply-template').map(c=>c.body);
  const requests=generations(f);
  assert.equal(templates.length,2);
  for(let i=0;i<requests.length;i++){
    assert.deepEqual(templates[i].messages,requests[i].messages);
    assert.deepEqual(requests[i].messages[0],{role:'system',content:REPLY_GUIDANCE});
    assert.equal(requests[i].messages.filter(m=>m.role==='system').length,1);
  }
});

test('server guidance consumes context before accepting or clamping a reply',async()=>{
  const messages=[{role:'user',content:'Hello'}],templateBodies=[],tokenizerBodies=[];
  // Character counts stand in for tokens to expose fixed server-prompt overhead
  // without relying on a particular real tokenizer or making a model request.
  const render=messages=>JSON.stringify(messages);
  const fullPrompt=render([{role:'system',content:REPLY_GUIDANCE},...messages]);
  const userPrompt=render(messages);
  const fetchImpl=async(url,settings)=>{
    const body=JSON.parse(settings.body);
    if(new URL(url).pathname==='/apply-template'){
      templateBodies.push(body);
      return Response.json({prompt:render(body.messages)});
    }
    assert.equal(new URL(url).pathname,'/tokenize','Preparation must not generate a reply.');
    tokenizerBodies.push(body);
    return Response.json({tokens:Array(body.content.length).fill(1)});
  };
  const signal=new AbortController().signal;
  const prepare=contextTokens=>createLlamaEngine({origin:'http://127.0.0.1:8081',fetchImpl,contextTokens})
    .prepare({messages,maxTokens:256,mode:'fast'},signal);
  assert.ok(fullPrompt.length+31-userPrompt.length>=256,'The user question alone would leave room for the requested reply.');
  await assert.rejects(prepare(fullPrompt.length+31),error=>error.status===422);
  assert.equal((await prepare(fullPrompt.length+40)).outputBudget,40);
  assert.deepEqual(templateBodies.map(body=>body.messages),[
    [{role:'system',content:REPLY_GUIDANCE},...messages],
    [{role:'system',content:REPLY_GUIDANCE},...messages],
  ]);
  assert.deepEqual(tokenizerBodies,[
    {content:fullPrompt,add_special:true},
    {content:fullPrompt,add_special:true},
  ]);
  assert.deepEqual(messages,[{role:'user',content:'Hello'}]);
});

test('changed templates, invalid usage and incomplete streams cannot continue or report DONE',async()=>{
  for(const [chunk,options] of [[{text:'first'},{mismatch:true}],[{text:'first',usage:{completion_tokens:3}},{}],[{text:'first',noDone:true},{}],[{text:'',tokens:0},{}],[{text:42},{}]]) {
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
test('long prefixes retain the current per-request allowance and short prefixes remain bounded',async()=>{
  const short=fixture([]),long=fixture([],{promptTokens:129}),signal=new AbortController().signal;
  assert.equal((await short.engine.prepare({...input,maxTokens:1024},signal)).outputBudget,512);
  assert.equal((await long.engine.prepare({...input,maxTokens:512},signal)).outputBudget,256);
});

test('Stop during cached generation clears the exclusive slot before another user starts',{timeout:5000},async t=>{
  const f=fixture([{text:'A'},{text:'B',tokens:1,finish:'stop'},{text:'C',tokens:1,finish:'stop'}],{chunkTokens:256,holdGeneration:2});
  const server=createGateway({engine:f.engine,origins:['https://offscript.test']});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close()});
  const url=`http://127.0.0.1:${server.address().port}`;
  const send=signal=>fetch(url+'/api/chat',{method:'POST',signal,headers:{Origin:'https://offscript.test','X-Offscript-Client':'web','Content-Type':'application/json'},body:JSON.stringify({...input,maxTokens:512})});
  const controller=new AbortController(),first=await send(controller.signal),reading=first.text();
  const cancelled=assert.rejects(reading);
  assert.equal(first.headers.get('x-offscript-protocol'),'5');
  for(let i=0;f.controls.length<2&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.controls.length,2);
  const second=send();let queued=false;
  for(let i=0;i<200;i++) {
    if((await (await fetch(url+'/api/health')).json()).queued===1){queued=true;break}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(queued);assert.equal(generations(f).length,2);
  controller.abort();await cancelled;
  const text=await (await second).text();assert.match(text,/"content":"C"/);assert.match(text,/workerStopped":true/);assert.match(text,/\[DONE\]/);
  assert.deepEqual(generations(f)[2].messages,[{role:'system',content:REPLY_GUIDANCE},...input.messages]);
  assert.deepEqual(f.calls.filter(c=>c.path.startsWith('/slots/')||c.path==='/v1/chat/completions').map(c=>c.path),['/slots/0','/v1/chat/completions','/v1/chat/completions','/slots/0','/slots/0','/v1/chat/completions','/slots/0']);
});
