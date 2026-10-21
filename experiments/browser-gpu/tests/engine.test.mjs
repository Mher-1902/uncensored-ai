import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserEngine,BrowserEngineError} from '../src/engine.ts';

const model=new Blob(['fixture model bytes']),prompt='Explain why the Earth has seasons.';
const gpuLogs=['ggml_webgpu: Found adapter: fixture GPU','load_tensors: offloaded 25/25 layers to GPU'];
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const code=expected=>error=>error instanceof BrowserEngineError&&error.code===expected;
const next=()=>new Promise(resolve=>setImmediate(resolve));
async function until(condition){for(let i=0;i<100;i++){if(condition())return;await next()}assert.fail('Fixture did not reach the expected state')}
function final(request,text='Hello',finish='stop',tokens=2){
  request.onData({choices:[{delta:{content:text},finish_reason:finish}],usage:{prompt_tokens:8,completion_tokens:tokens},timings:{predicted_per_second:42.5}});
}
function mockRuntime(logger,options={}){
  const state={loads:[],requests:[],exits:0};
  const runtime={
    isSupportWebGPU:()=>options.capable!==false,
    async loadModel(blobs,settings){
      state.loads.push({blobs,settings});
      for(const line of options.logs??gpuLogs)logger.debug(line);
      if(options.load)await options.load(state,logger);
    },
    async createChatCompletion(request){state.requests.push(request);if(options.generate)await options.generate(request,state);else final(request);},
    async exit(){state.exits++;if(options.exit)await options.exit(state);},
    modelManager:{getModelOrDownload(){assert.fail('The wrapper must not download or cache a model');}},
  };
  return {runtime,state};
}
function options(extra={}){return {signal:new AbortController().signal,onText:()=>{},onStatus:()=>{},...extra}}

test('each fixed-prompt run creates and unloads a fresh GPU worker without model-cache operations',async()=>{
  const runs=[],texts=[],statuses=[];let clock=0;
  const engine=new BrowserEngine(logger=>{const f=mockRuntime(logger);runs.push(f);return f.runtime},{now:()=>clock+=10});
  for(let i=0;i<2;i++){
    const result=await engine.run(model,prompt,options({onText:text=>texts.push(text),onStatus:status=>statuses.push(status)}));
    assert.equal(result.complete,true);assert.equal(result.finishReason,'stop');assert.equal(result.outputTokens,2);
    assert.equal(result.promptTokens,8);assert.equal(result.characters,5);assert.equal(result.offloadedLayers,25);assert.equal(result.totalLayers,25);
    assert.equal(result.nativeDecodeTokensPerSecond,42.5);assert.ok(result.loadMs>0&&result.firstTextMs>=0&&result.generationMs>0&&result.cleanupMs>0);
    assert.ok(result.totalMs>=result.loadMs+result.generationMs+result.cleanupMs);
    assert.doesNotMatch(JSON.stringify(result),/Hello|Earth|fixture GPU|fixture model/);
  }
  assert.equal(runs.length,2);assert.notEqual(runs[0].runtime,runs[1].runtime);assert.deepEqual(texts,['Hello','Hello']);
  assert.deepEqual(statuses,['starting','loading','generating','starting','loading','generating']);
  for(const {state} of runs){
    assert.equal(state.exits,1);assert.deepEqual(state.loads[0].blobs,[model]);
    assert.deepEqual(state.loads[0].settings,{n_gpu_layers:99999,n_parallel:1,n_ctx:2048,n_threads:1,cache_idle_slots:false,n_cache_reuse:0,ctx_shift:false,warmup:false,jinja:true,reasoning:false,default_template_kwargs:{enable_thinking:false},log_level:2});
    const request=state.requests[0];assert.deepEqual(request.messages,[{role:'user',content:prompt}]);
    assert.equal(request.stream,true);assert.equal(request.abortSignal.aborted,false);assert.equal(request.signal,undefined);
    assert.equal(request.max_tokens,128);assert.equal(request.temperature,0);assert.equal(request.seed,42);assert.equal(request.cache_prompt,false);
    assert.deepEqual(request.chat_template_kwargs,{enable_thinking:false});
  }
});

test('GPU capability is insufficient: missing, partial, failed or unrecognized native evidence rejects before generation',async()=>{
  for(const logs of [[],['WebGPU is available','load_tensors: offloaded 25/25 layers to GPU'],['ggml_webgpu: Found adapter: fixture GPU'],['ggml_webgpu: Found adapter: fixture GPU','load_tensors: offloaded 0/25 layers to GPU'],['ggml_webgpu: Found adapter: fixture GPU','load_tensors: offloaded 12/25 layers to GPU'],[...gpuLogs,'ggml_webgpu: error while creating device']]){
    let fixture;const engine=new BrowserEngine(logger=>(fixture=mockRuntime(logger,{logs})).runtime);
    await assert.rejects(engine.run(model,prompt,options()),code('gpu_unverified'));
    assert.equal(fixture.state.loads.length,1);assert.equal(fixture.state.requests.length,0);assert.equal(fixture.state.exits,1);
  }
  let fixture;const engine=new BrowserEngine(logger=>(fixture=mockRuntime(logger,{capable:false})).runtime);
  await assert.rejects(engine.run(model,prompt,options()),code('unsupported_gpu'));
  assert.equal(fixture.state.loads.length,0);assert.equal(fixture.state.requests.length,0);assert.equal(fixture.state.exits,1);
});

test('raw diagnostics and arbitrary runtime errors never reach statuses, metrics or public errors',async()=>{
  const statuses=[],texts=[];let fixture;
  const engine=new BrowserEngine(logger=>(fixture=mockRuntime(logger,{load:(_state,output)=>{
    output.debug({prompt:'PRIVATE PROMPT'});output.log('PRIVATE OUTPUT');output.error({token:'PRIVATE TOKEN'});
    throw Error('PRIVATE PROMPT PRIVATE TOKEN PRIVATE OUTPUT');
  }})).runtime);
  await assert.rejects(engine.run(model,prompt,options({onStatus:value=>statuses.push(value),onText:value=>texts.push(value)})),error=>{
    assert.ok(code('load_failed')(error));assert.doesNotMatch(error.message,/PRIVATE/);return true;
  });
  assert.deepEqual(statuses,['starting','loading']);assert.deepEqual(texts,[]);assert.equal(fixture.state.exits,1);
});

test('Stop during load exits immediately, blocks a replacement until the late load is disposed, and suppresses stale updates',{timeout:3000},async()=>{
  const loading=deferred(),runs=[],texts=[],controller=new AbortController();
  const engine=new BrowserEngine(logger=>{const f=mockRuntime(logger,runs.length===0?{load:()=>loading.promise}:{});runs.push(f);return f.runtime});
  const result=engine.run(model,prompt,options({signal:controller.signal,onText:text=>texts.push(text)})),rejected=assert.rejects(result,code('stopped'));
  await until(()=>runs[0]?.state.loads.length===1);await engine.stop();await rejected;
  assert.equal(runs[0].state.exits,1);assert.equal(runs[0].state.requests.length,0);
  await assert.rejects(engine.run(model,prompt,options()),code('resetting'));assert.equal(runs.length,1);
  loading.resolve();await until(()=>runs[0].state.exits===2);await next();
  assert.deepEqual(texts,[]);
  const replacement=await engine.run(model,prompt,options());assert.equal(replacement.complete,true);assert.equal(runs.length,2);
  assert.equal(runs[1].state.exits,1);
});

test('an external abort during load has the same cleanup boundary as Stop',{timeout:3000},async()=>{
  const loading=deferred(),controller=new AbortController();let fixture;
  const engine=new BrowserEngine(logger=>(fixture=mockRuntime(logger,{load:()=>loading.promise})).runtime);
  const result=engine.run(model,prompt,options({signal:controller.signal})),rejected=assert.rejects(result,code('stopped'));
  await until(()=>fixture?.state.loads.length===1);controller.abort();await rejected;
  assert.equal(fixture.state.exits,1);assert.equal(fixture.state.requests.length,0);
  loading.resolve();await until(()=>fixture.state.exits===2);
});

test('Stop during inference aborts and exits without waiting on a hung generation; stale callbacks cannot mutate a newer run',{timeout:3000},async()=>{
  const oldGeneration=deferred(),newGeneration=deferred(),runs=[],oldText=[],newText=[];
  const engine=new BrowserEngine(logger=>{
    const pending=runs.length===0?oldGeneration:newGeneration;
    const f=mockRuntime(logger,{generate:()=>pending.promise});runs.push(f);return f.runtime;
  });
  const old=engine.run(model,prompt,options({onText:text=>oldText.push(text)})),rejected=assert.rejects(old,code('stopped'));
  await until(()=>runs[0]?.state.requests.length===1);const request=runs[0].state.requests[0];
  request.onData({choices:[{delta:{content:'Partial'},finish_reason:null}]});
  await engine.stop();await rejected;assert.equal(request.abortSignal.aborted,true);assert.equal(runs[0].state.exits,1);
  const replacement=engine.run(model,prompt,options({onText:text=>newText.push(text)}));
  await until(()=>runs[1]?.state.requests.length===1);
  final(request,'STALE');oldGeneration.resolve();await next();
  assert.deepEqual(oldText,['Partial']);assert.deepEqual(newText,[]);
  await assert.rejects(engine.run(model,prompt,options()),code('busy'));
  final(runs[1].state.requests[0],'Fresh');newGeneration.resolve();const metrics=await replacement;
  assert.equal(metrics.complete,true);assert.deepEqual(newText,['Fresh']);assert.equal(runs[1].state.exits,1);
});

test('a cancelled factory result is disposed later without loading or publishing readiness',{timeout:3000},async()=>{
  const factory=deferred(),controller=new AbortController(),statuses=[];let logger;
  const engine=new BrowserEngine(value=>{logger=value;return factory.promise});
  const result=engine.run(model,prompt,options({signal:controller.signal,onStatus:status=>statuses.push(status)})),rejected=assert.rejects(result,code('stopped'));
  await until(()=>logger!==undefined);controller.abort();await rejected;
  const fixture=mockRuntime(logger);factory.resolve(fixture.runtime);await until(()=>fixture.state.exits===1);
  assert.equal(fixture.state.loads.length,0);assert.equal(fixture.state.requests.length,0);assert.deepEqual(statuses,['starting']);
});

test('a pre-aborted test does not create a worker or begin loading',async()=>{
  const controller=new AbortController();controller.abort();let factories=0;
  const engine=new BrowserEngine(()=>{factories++;throw Error('must not construct')});
  await assert.rejects(engine.run(model,prompt,options({signal:controller.signal})),code('stopped'));assert.equal(factories,0);
});

test('bounded synthetic length stops remain explicitly incomplete, and absent usage never becomes an invented token rate',async()=>{
  const capped=new BrowserEngine(logger=>mockRuntime(logger,{generate:request=>final(request,'Bounded fixture','length',128)}).runtime);
  const result=await capped.run(model,prompt,options());assert.equal(result.complete,false);assert.equal(result.finishReason,'length');assert.equal(result.outputTokens,128);
  const unknown=new BrowserEngine(logger=>mockRuntime(logger,{generate:request=>request.onData({choices:[{delta:{content:'Done'},finish_reason:'stop'}]})}).runtime);
  const metrics=await unknown.run(model,prompt,options());assert.equal(metrics.outputTokens,null);assert.equal(metrics.promptTokens,null);
  assert.equal(metrics.nativeDecodeTokensPerSecond,null);assert.equal(metrics.generationTokensPerSecond,null);
});

test('invalid usage, hidden thinking and streams without a final reason cannot pass completion checks',async()=>{
  for(const chunk of [
    {choices:[{delta:{content:'Partial'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:129}},
    {choices:[{delta:{reasoning_content:'Hidden'},finish_reason:null}]},
    {choices:[{delta:{content:'Partial'},finish_reason:'tool_calls'}]},
    {choices:[{delta:{content:'Partial'},finish_reason:null}]},
  ]){
    let fixture;const engine=new BrowserEngine(logger=>(fixture=mockRuntime(logger,{generate:request=>request.onData(chunk)})).runtime);
    await assert.rejects(engine.run(model,prompt,options()),error=>error instanceof BrowserEngineError&&['generation_failed','incomplete'].includes(error.code));
    assert.equal(fixture.state.exits,1);
  }
});

test('failed cleanup permanently closes admission to additional device tests',async()=>{
  let fixture,factories=0;const engine=new BrowserEngine(logger=>{factories++;return (fixture=mockRuntime(logger,{exit:()=>{throw Error('PRIVATE runtime cleanup failure')}})).runtime});
  await assert.rejects(engine.run(model,prompt,options()),error=>{assert.ok(code('cleanup_failed')(error));assert.doesNotMatch(error.message,/PRIVATE/);return true});
  assert.equal(fixture.state.exits,1);await assert.rejects(engine.run(model,prompt,options()),code('resetting'));assert.equal(factories,1);
});

test('a hung exit times out and never permits a concurrent replacement',{timeout:1000},async()=>{
  const hanging=deferred();const engine=new BrowserEngine(logger=>mockRuntime(logger,{exit:()=>hanging.promise}).runtime,{cleanupTimeoutMs:5});
  await assert.rejects(engine.run(model,prompt,options()),code('cleanup_failed'));
  await assert.rejects(engine.run(model,prompt,options()),code('resetting'));
});

test('a factory cannot recycle an old worker instance across runs',async()=>{
  let fixture;const engine=new BrowserEngine(logger=>{fixture??=mockRuntime(logger);return fixture.runtime});
  await engine.run(model,prompt,options());await assert.rejects(engine.run(model,prompt,options()),code('initialization_failed'));
  assert.equal(fixture.state.loads.length,1);assert.equal(fixture.state.requests.length,1);assert.equal(fixture.state.exits,2);
});
