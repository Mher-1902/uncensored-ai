export type BrowserStatus='starting'|'loading'|'generating'|'stopping';
export type BrowserEngineCode='busy'|'resetting'|'invalid_input'|'unsupported_gpu'|'gpu_unverified'|'initialization_failed'|'load_failed'|'generation_failed'|'incomplete'|'stopped'|'timeout'|'cleanup_failed';
const messages:Record<BrowserEngineCode,string>={
  busy:'A device test is already running.',
  resetting:'The previous device test is still resetting. Reload this prototype before another run.',
  invalid_input:'The test model or fixed prompt is invalid.',
  unsupported_gpu:'This browser cannot run this GPU test. CPU fallback is disabled.',
  gpu_unverified:'GPU execution was not confirmed. CPU fallback is disabled.',
  initialization_failed:'The device runtime could not start.',
  load_failed:'The model could not load on this device.',
  generation_failed:'The device test could not produce a verified reply.',
  incomplete:'The device test ended without a verified completion.',
  stopped:'The device test was stopped.',
  timeout:'The device test exceeded its time limit.',
  cleanup_failed:'Device cleanup could not be confirmed. Reload this prototype before another run.',
};
export class BrowserEngineError extends Error {
  readonly code:BrowserEngineCode;
  constructor(code:BrowserEngineCode){super(messages[code]);this.name='BrowserEngineError';this.code=code;}
}
export type BrowserLogger={debug:(...data:unknown[])=>void;log:(...data:unknown[])=>void;warn:(...data:unknown[])=>void;error:(...data:unknown[])=>void};
export type LoadOptions={n_gpu_layers:number;n_parallel:number;n_ctx:number;n_threads:number;cache_idle_slots:boolean;n_cache_reuse:number;ctx_shift:boolean;warmup:boolean;jinja:boolean;reasoning:boolean;default_template_kwargs:Record<string,boolean>;log_level:number};
export type CompletionOptions={messages:{role:'user';content:string}[];stream:true;onData:(chunk:unknown)=>void;abortSignal:AbortSignal;max_tokens:number;temperature:number;seed:number;cache_prompt:boolean;chat_template_kwargs:Record<string,boolean>;timings_per_token:boolean};
export interface BrowserRuntime {
  isSupportWebGPU():boolean;
  loadModel(models:Blob[],options:LoadOptions):Promise<void>;
  createChatCompletion(options:CompletionOptions):Promise<unknown>;
  exit():Promise<void>;
}
export type RuntimeFactory=(logger:BrowserLogger)=>BrowserRuntime|Promise<BrowserRuntime>;
export type BrowserMetrics={
  loadMs:number;firstTextMs:number|null;generationMs:number;totalMs:number;cleanupMs:number;
  characters:number;promptTokens:number|null;outputTokens:number|null;finishReason:'stop'|'length';complete:boolean;
  offloadedLayers:number;totalLayers:number;nativeDecodeTokensPerSecond:number|null;generationTokensPerSecond:number|null;
};
type ActiveRun={
  controller:AbortController;runtime:BrowserRuntime|null;acceptUpdates:boolean;reason:'stopped'|'timeout';
  phase:'starting'|'loading'|'generating';load:Promise<void>|null;loadSettled:boolean;exit:Promise<void>|null;
};
type EngineOptions={now?:()=>number;runTimeoutMs?:number;cleanupTimeoutMs?:number};
type RunOptions={signal:AbortSignal;onText:(text:string)=>void;onStatus:(status:BrowserStatus)=>void};

function cancelled(signal:AbortSignal):never{throw signal.reason;}
async function withAbort<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return cancelled(signal);
  let abort:(()=>void)|undefined;
  try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{
    abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  })]);}finally{if(abort)signal.removeEventListener('abort',abort);}
}

// A narrow, fixed-prompt research wrapper. It has no network, cache manager,
// account, storage or production-chat interface. Each run gets a new worker.
export class BrowserEngine {
  private readonly factory:RuntimeFactory;
  private readonly now:()=>number;
  private readonly runTimeoutMs:number;
  private readonly cleanupTimeoutMs:number;
  private readonly used=new WeakSet<object>();
  private active:ActiveRun|null=null;
  private retiring:Promise<void>|null=null;
  private poisoned=false;
  constructor(factory:RuntimeFactory,options:EngineOptions={}){
    this.factory=factory;this.now=options.now??(()=>performance.now());
    this.runTimeoutMs=options.runTimeoutMs??120000;this.cleanupTimeoutMs=options.cleanupTimeoutMs??3000;
    if(typeof factory!=='function'||![this.runTimeoutMs,this.cleanupTimeoutMs].every(value=>Number.isFinite(value)&&value>0))throw new BrowserEngineError('invalid_input');
  }
  private current(run:ActiveRun){return this.active===run&&run.acceptUpdates&&!run.controller.signal.aborted;}
  private async boundedExit(runtime:BrowserRuntime):Promise<void>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([Promise.resolve().then(()=>runtime.exit()),new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new BrowserEngineError('cleanup_failed')),this.cleanupTimeoutMs);
    })]);}catch{this.poisoned=true;throw new BrowserEngineError('cleanup_failed');}
    finally{clearTimeout(timer);}
  }
  private terminate(run:ActiveRun):Promise<void>{
    if(!run.runtime)return Promise.resolve();
    return run.exit??=this.boundedExit(run.runtime);
  }
  async stop():Promise<void>{
    const run=this.active;if(!run)return;
    run.reason='stopped';run.acceptUpdates=false;run.controller.abort();
    await this.terminate(run);
  }
  async run(model:Blob,prompt:string,options:RunOptions):Promise<BrowserMetrics>{
    if(this.active)throw new BrowserEngineError('busy');
    if(this.poisoned||this.retiring)throw new BrowserEngineError('resetting');
    if(!(model instanceof Blob)||model.size<1||model.size>2000000000||typeof prompt!=='string'||!prompt.trim()||prompt.length>8192)throw new BrowserEngineError('invalid_input');
    if(options.signal.aborted)throw new BrowserEngineError('stopped');
    const run:ActiveRun={controller:new AbortController(),runtime:null,acceptUpdates:true,reason:'stopped',phase:'starting',load:null,loadSettled:false,exit:null};
    this.active=run;
    let webgpu=false,gpuFailure=false,offloaded=0,totalLayers=0;
    // Parse only bounded loading diagnostics into counters. No raw diagnostic,
    // prompt, generated token or device identifier is retained or forwarded.
    const observe=(...data:unknown[])=>{
      if(!this.current(run)||run.phase!=='loading')return;
      for(const value of data)if(typeof value==='string'&&value.length<=8192)for(const raw of value.split('\n')){
        const line=raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'').trim();
        // This exact prefix is present in the pinned 3.8.1 WASM. Its values
        // are discarded; do not retain vendor/device identifiers.
        if(/^ggml_webgpu:\s+adapter_info:/i.test(line))webgpu=true;
        if(/^(?:ggml_webgpu|ggml_backend_webgpu(?:_\w+)?):/i.test(line)&&/\b(?:adapter|device|backend|buffer|memory)\b/i.test(line))webgpu=true;
        if(/^(?:llama_model_load_from_file_impl|llama_model_load):\s+using device WebGPU\d*\b/i.test(line))webgpu=true;
        if(/^(?:load_tensors|llama_model_load_tensors):\s+WebGPU\d*\s+(?:model\s+)?buffer\b/i.test(line))webgpu=true;
        if(/^(?:ggml_webgpu|ggml_backend_webgpu(?:_\w+)?):/i.test(line)&&/\b(?:failed|unavailable|unsupported|error|lost|exhausted|timed out)\b/i.test(line))gpuFailure=true;
        const match=line.match(/^(?:load_tensors|llama_model_load_tensors):\s+offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers to GPU\b/i);
        if(match){const loaded=Number(match[1]),total=Number(match[2]);if(loaded>0&&total>0&&loaded<=total&&total<10000){offloaded=loaded;totalLayers=total;}}
      }
    };
    // Wllama maps native INFO messages to logger.debug. These bounded loading
    // lines are needed for offload proof; generation-phase data is discarded.
    const logger:BrowserLogger={debug:observe,log:observe,warn:observe,error:observe};
    const abort=()=>{
      run.reason='stopped';run.acceptUpdates=false;run.controller.abort();
      void this.terminate(run).catch(()=>{});
    };
    options.signal.addEventListener('abort',abort,{once:true});
    if(options.signal.aborted)abort();
    const timeout=setTimeout(()=>{
      run.reason='timeout';run.acceptUpdates=false;run.controller.abort();
      void this.terminate(run).catch(()=>{});
    },this.runTimeoutMs);
    const started=this.now();let result:BrowserMetrics|undefined;
    const check=()=>{if(!this.current(run))throw new BrowserEngineError(run.reason);};
    try{
      check();options.onStatus('starting');
      const pending=Promise.resolve().then(()=>{check();return this.factory(logger);});
      // A cancelled dynamic import/factory can finish later. It must not start
      // loading a model, publish readiness or resurrect a retired worker.
      void pending.then(runtime=>{
        if(!this.current(run))void this.boundedExit(runtime).catch(()=>{});
      },()=>{});
      const runtime=await withAbort(pending,run.controller.signal);run.runtime=runtime;check();
      if(this.used.has(runtime))throw new BrowserEngineError('initialization_failed');
      this.used.add(runtime);
      // Capability alone is insufficient. Native positive offload evidence is
      // required again after loading, before any prompt reaches generation.
      if(!runtime.isSupportWebGPU())throw new BrowserEngineError('unsupported_gpu');
      run.phase='loading';options.onStatus('loading');const loadStarted=this.now();
      const loading=Promise.resolve().then(()=>{check();return runtime.loadModel([model],{
        n_gpu_layers:99999,n_parallel:1,n_ctx:2048,n_threads:1,cache_idle_slots:false,n_cache_reuse:0,ctx_shift:false,warmup:false,
        jinja:true,reasoning:false,default_template_kwargs:{enable_thinking:false},log_level:2,
      });});
      run.load=loading;
      void loading.then(()=>{run.loadSettled=true},()=>{run.loadSettled=true});
      await withAbort(loading,run.controller.signal);check();
      const loadMs=this.now()-loadStarted;
      if(!webgpu||gpuFailure||offloaded<1||offloaded!==totalLayers)throw new BrowserEngineError('gpu_unverified');
      run.phase='generating';options.onStatus('generating');check();
      const generationStarted=this.now();let firstText:number|null=null,text='',finish:'stop'|'length'|null=null;
      let promptTokens:number|null=null,outputTokens:number|null=null,nativeDecode:number|null=null;
      const generating=runtime.createChatCompletion({
        messages:[{role:'user',content:prompt}],stream:true,abortSignal:run.controller.signal,max_tokens:128,temperature:0,seed:42,
        cache_prompt:false,chat_template_kwargs:{enable_thinking:false},timings_per_token:true,
        onData:(chunk:unknown)=>{
          if(!this.current(run))return;
          if(!chunk||typeof chunk!=='object')throw new BrowserEngineError('generation_failed');
          const frame=chunk as {choices?:{delta?:{content?:unknown;reasoning_content?:unknown};finish_reason?:unknown}[];usage?:{prompt_tokens?:unknown;completion_tokens?:unknown};timings?:{predicted_per_second?:unknown}};
          if(frame.choices!==undefined&&!Array.isArray(frame.choices))throw new BrowserEngineError('generation_failed');
          const choice=frame.choices?.[0];
          if(choice?.delta?.reasoning_content)throw new BrowserEngineError('generation_failed');
          if(choice?.delta?.content!=null){
            if(typeof choice.delta.content!=='string'||text.length+choice.delta.content.length>65536)throw new BrowserEngineError('generation_failed');
            if(choice.delta.content){firstText??=this.now();text+=choice.delta.content;options.onText(text);}
          }
          if(choice?.finish_reason!=null){
            if(!['stop','length'].includes(String(choice.finish_reason))||finish&&finish!==choice.finish_reason)throw new BrowserEngineError('generation_failed');
            finish=choice.finish_reason as 'stop'|'length';
          }
          if(frame.usage!=null){
            const p=frame.usage.prompt_tokens,c=frame.usage.completion_tokens;
            if(typeof p!=='number'||typeof c!=='number'||!Number.isInteger(p)||!Number.isInteger(c)||p<0||c<0||c>128||p+c>2048)throw new BrowserEngineError('generation_failed');
            promptTokens=p;outputTokens=c;
          }
          const rate=frame.timings?.predicted_per_second;
          if(typeof rate==='number'&&Number.isFinite(rate)&&rate>0)nativeDecode=rate;
        },
      });
      await withAbort(generating,run.controller.signal);check();
      if(!finish||!text.trim())throw new BrowserEngineError('incomplete');
      const generationMs=this.now()-generationStarted;
      result={loadMs,firstTextMs:firstText===null?null:firstText-generationStarted,generationMs,totalMs:0,cleanupMs:0,
        characters:text.length,promptTokens,outputTokens,finishReason:finish,complete:finish==='stop',offloadedLayers:offloaded,totalLayers,
        nativeDecodeTokensPerSecond:nativeDecode,generationTokensPerSecond:outputTokens!==null&&generationMs>0?outputTokens/(generationMs/1000):null};
    }catch(error){
      if(run.controller.signal.aborted)throw new BrowserEngineError(run.reason);
      if(error instanceof BrowserEngineError)throw error;
      throw new BrowserEngineError(run.phase==='generating'?'generation_failed':run.phase==='loading'?'load_failed':'initialization_failed');
    }finally{
      run.acceptUpdates=false;clearTimeout(timeout);options.signal.removeEventListener('abort',abort);
      const cleanupStarted=this.now();
      try{await this.terminate(run);}
      finally{
        // loadModel has no abort parameter. If it has not settled, another
        // load could create a worker after the first exit. Keep the engine
        // blocked until a second exit after that late result; never free a
        // newer run's state from the older run's cleanup.
        if(run.runtime&&run.load&&!run.loadSettled){
          const runtime=run.runtime;
          const retired=run.load.then(()=>this.boundedExit(runtime),()=>this.boundedExit(runtime));
          this.retiring=retired;
          void retired.then(()=>{if(this.retiring===retired)this.retiring=null},()=>{this.poisoned=true;});
        }
        if(this.active===run)this.active=null;
        if(result){result.cleanupMs=this.now()-cleanupStarted;result.totalMs=this.now()-started;}
      }
    }
    return result!;
  }
}
