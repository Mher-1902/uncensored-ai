import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createLlamaEngine} from '../server/llama-engine.mjs';
import {createGateway} from '../server/index.mjs';
import {readEvents} from '../src/stream.ts';

function fixture(chunks,options={}) {
  const calls=[],controls=[],aborted=[];let templates=0,generations=0;
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
      const generation=++generations,chunk=chunks[generation-1];assert.ok(chunk,'Unexpected generation');
      const choice={delta:{content:chunk.text},finish_reason:chunk.finish??'length'};
      const usage={prompt_tokens:generations===1?10:99,completion_tokens:chunk.tokens??body.max_tokens,...chunk.usage};
      const stream=`data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\ndata: ${JSON.stringify({choices:[choice]})}\n\ndata: ${JSON.stringify({usage})}\n\n${chunk.noDone?'':'data: [DONE]\n\n'}`;
      let closed=false,output;
      const onAbort=()=>{aborted.push(generation);close()};
      const close=()=>{if(closed)return;closed=true;settings.signal.removeEventListener('abort',onAbort);try{output.close()}catch{}};
      const bodyStream=new ReadableStream({start(controller){
        output=controller;settings.signal.addEventListener('abort',onAbort,{once:true});
        const write=()=>{if(closed)return;output.enqueue(new TextEncoder().encode(stream));close()};
        controls.push(write);
        if(settings.signal.aborted)close();else if(generations!==options.holdGeneration)write();
      },cancel:close});
      return new Response(bodyStream,{headers:{'Content-Type':'text/event-stream'}});
    }
    throw Error('Unexpected engine route');
  };
  return {calls,controls,aborted,fetchImpl,engine:createLlamaEngine({origin:'http://127.0.0.1:8081',fetchImpl,chunkTokens:options.chunkTokens??2,maxFastTokens:options.maxFastTokens??512})};
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

test('the optional 768 allowance preserves the exact prefix boundary and the existing Deep budget',async()=>{
  const signal=new AbortController().signal;
  for(const [promptTokens,expected] of [[128,768],[129,256]]) {
    const f=fixture([],{maxFastTokens:768,promptTokens});
    assert.equal((await f.engine.prepare({...input,maxTokens:1024},signal)).outputBudget,expected);
    assert.equal((await f.engine.prepare({...input,maxTokens:256,mode:'deep'},signal)).outputBudget,512);
    assert.equal((await f.engine.prepare({...input,maxTokens:256,mode:'deep'},signal)).reasoningBudget,256);
  }
  for(const maxFastTokens of [256,769,1024,'768',null]) {
    assert.throws(()=>createLlamaEngine({origin:'http://127.0.0.1:8081',maxFastTokens}),/Fast request allowance/);
  }
});

test('three internal chunks preserve exact code whitespace and aggregate one request allowance',async()=>{
  for(const finish of ['stop','length']) {
    const finalTokens=finish==='stop'?17:256;
    const f=fixture([{text:'Code:\n  ',tokens:256},{text:'return ',tokens:256},{text:'42;\n',tokens:finalTokens,finish}],{maxFastTokens:768,chunkTokens:256});
    const events=await answer(f,{...input,maxTokens:768}),requests=generations(f);
    assert.deepEqual(requests.map(r=>r.max_tokens),[256,256,256]);
    assert.ok(requests.every(r=>r.cache_prompt===true&&r.id_slot===0));
    assert.equal(requests[1].messages.at(-1).content,'Code:\n  ');
    assert.equal(requests[2].messages.at(-1).content,'Code:\n  return ');
    assert.deepEqual(events.at(-2),{choices:[{delta:{},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:512+finalTokens,total_tokens:522+finalTokens}});
    assert.equal(events.at(-1),'[DONE]');
  }
});

test('a broken third chunk cannot turn a larger request into a successful completion',async()=>{
  for(const third of [{text:'end',noDone:true},{text:'end',usage:{completion_tokens:257}},{text:'',tokens:0},{text:42}]) {
    const f=fixture([{text:'first',tokens:256},{text:'second',tokens:256},third],{maxFastTokens:768,chunkTokens:256}),seen=[];
    const signal=new AbortController().signal,response=await f.engine.generate(await f.engine.prepare({...input,maxTokens:768},signal),signal);
    await assert.rejects(async()=>{for await(const raw of readEvents(response.body))seen.push(raw)});
    assert.equal(generations(f).length,3);assert.ok(!seen.includes('[DONE]'));
  }
});

test('the native deployment ceiling remains 512 unless the exact 768 setting is enabled',async t=>{
  const previous=process.env.FAST_REPLY_TOKENS;
  t.after(()=>{if(previous===undefined)delete process.env.FAST_REPLY_TOKENS;else process.env.FAST_REPLY_TOKENS=previous});
  for(const value of [undefined,'512','768','768 ','1024']) {
    if(value===undefined)delete process.env.FAST_REPLY_TOKENS;else process.env.FAST_REPLY_TOKENS=value;
    const f=fixture([{text:'A',tokens:256},{text:'B',tokens:256},{text:'C',tokens:1,finish:'stop'}],{chunkTokens:256});
    const server=createGateway({fetchImpl:f.fetchImpl,origins:['https://offscript.test']});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    try {
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api/chat`,{method:'POST',headers:{Origin:'https://offscript.test','X-Offscript-Client':'web','Content-Type':'application/json'},body:JSON.stringify({...input,maxTokens:768})});
      assert.equal(response.status,200);const events=[];
      for await(const raw of readEvents(response.body))events.push(raw==='[DONE]'?raw:JSON.parse(raw));
      assert.equal(generations(f).length,value==='768'?3:2);
      assert.equal(events.find(e=>e.usage)?.usage.completion_tokens,value==='768'?513:512);
      assert.equal(events.at(-1),'[DONE]');
      assert.equal(f.calls.filter(c=>c.path.startsWith('/slots/')).length,2);
    } finally {server.closeAllConnections();server.close()}
  }
});

test('Stop in chunk three aborts its generation and disposes before a fresh question starts',{timeout:5000},async t=>{
  const f=fixture([{text:'A',tokens:256},{text:'B',tokens:256},{text:'C',tokens:1,finish:'stop'},{text:'Fresh',tokens:1,finish:'stop'}],{maxFastTokens:768,chunkTokens:256,holdGeneration:3});
  const server=createGateway({engine:f.engine,origins:['https://offscript.test']});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close()});
  const url=`http://127.0.0.1:${server.address().port}`;
  const send=(messages,signal)=>fetch(url+'/api/chat',{method:'POST',signal,headers:{Origin:'https://offscript.test','X-Offscript-Client':'web','Content-Type':'application/json'},body:JSON.stringify({...input,messages,maxTokens:768})});
  const controller=new AbortController(),first=await send(input.messages,controller.signal),cancelled=assert.rejects(first.text());
  for(let i=0;f.controls.length<3&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.controls.length,3);
  const fresh=[{role:'user',content:'An unrelated fresh question'}],second=send(fresh);let queued=false;
  for(let i=0;i<200;i++) {
    if((await (await fetch(url+'/api/health')).json()).queued===1){queued=true;break}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(queued);assert.equal(generations(f).length,3);
  controller.abort();await cancelled;
  const text=await (await second).text();assert.match(text,/"content":"Fresh"/);assert.match(text,/workerStopped":true/);assert.match(text,/\[DONE\]/);
  assert.deepEqual(f.aborted,[3]);assert.deepEqual(generations(f)[3].messages,fresh);
  assert.deepEqual(f.calls.filter(c=>c.path.startsWith('/slots/')||c.path==='/v1/chat/completions').map(c=>c.path),['/slots/0','/v1/chat/completions','/v1/chat/completions','/v1/chat/completions','/slots/0','/slots/0','/v1/chat/completions','/slots/0']);
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
  assert.equal(generations(f)[2].messages.length,1);
  assert.deepEqual(f.calls.filter(c=>c.path.startsWith('/slots/')||c.path==='/v1/chat/completions').map(c=>c.path),['/slots/0','/v1/chat/completions','/v1/chat/completions','/slots/0','/slots/0','/v1/chat/completions','/slots/0']);
});
