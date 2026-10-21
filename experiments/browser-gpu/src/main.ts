import './style.css';
import {BrowserEngine} from './engine.ts';
import {downloadModel,savedModel,removeModel,manifest} from './model-store.ts';
const node=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const buttons=Object.fromEntries(['check','download','saved','remove','general','coding','stop','clear'].map(id=>[id,node<HTMLButtonElement>(id)]));
const consent=node<HTMLInputElement>('consent'),progress=node<HTMLProgressElement>('progress');
let compatible=false,model:Blob|undefined,active:AbortController|undefined,epoch=0;
const status=(message:string)=>{node('status').textContent=message;};
const engine=new BrowserEngine(async logger=>{
  const {Wllama}=await import('@wllama/wllama');
  const runtime=new Wllama({default:new URL('/runtime/wllama.wasm',location.origin).href},{logger,suppressNativeLog:false});
  // The package constructor enables a CDN compatibility build by default.
  // This prototype uses only the reviewed, self-hosted default build.
  runtime.setCompat(null);return runtime;
});
function update(){
  const busy=Boolean(active);
  buttons.check.disabled=busy;consent.disabled=busy;
  buttons.download.disabled=busy||!compatible||!consent.checked;
  buttons.saved.disabled=busy||!compatible;
  buttons.general.disabled=busy||!compatible||!model;
  buttons.coding.disabled=buttons.general.disabled;
  buttons.remove.disabled=busy;buttons.stop.disabled=!busy;
}
function advance(bytes:number){progress.value=100*bytes/manifest.bytes;node('model').textContent=`${(bytes/1e9).toFixed(2)} / ${(manifest.bytes/1e9).toFixed(2)} GB verified`;}
async function task(action:(signal:AbortSignal,ticket:number)=>Promise<void>){
  if(active)return;
  const ticket=++epoch,controller=new AbortController();active=controller;update();
  try{await action(controller.signal,ticket);}
  catch(error){if(ticket===epoch)status(controller.signal.aborted?'Stopped. This test was not completed.':error instanceof Error&&error.name==='NotFoundError'?'No complete saved model was found. Choose Download model first.':'The test could not finish. No server fallback was started. Check compatibility and available memory before retrying.');}
  finally{if(ticket===epoch){active=undefined;update();}}
}
buttons.check.addEventListener('click',()=>void task(async(signal)=>{
  compatible=false;model=undefined;node('device').textContent='Checking browser GPU support…';
  type Adapter={isFallbackAdapter?:boolean;requestDevice:()=>Promise<{destroy:()=>void}>};
  type GPU={requestAdapter:(options:{powerPreference:string;forceFallbackAdapter:boolean})=>Promise<Adapter|null>};
  const gpu=(navigator as unknown as {gpu?:GPU}).gpu;
  const wasm=WebAssembly as unknown as {Suspending?:unknown;promising?:unknown};
  let memory64=false;
  try{new WebAssembly.Memory({address:'i64',initial:1n} as unknown as WebAssembly.MemoryDescriptor);memory64=true}catch{/* Default WASM needs memory64. */}
  if(!isSecureContext||!gpu||!wasm.Suspending||!wasm.promising||!memory64||!navigator.storage?.getDirectory||!navigator.locks){
    node('device').textContent='This browser does not support the prototype. Try a recent compatible Chrome or Edge browser. The live website still works.';return;
  }
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance',forceFallbackAdapter:false});signal.throwIfAborted();
  if(!adapter||adapter.isFallbackAdapter){node('device').textContent='No suitable GPU adapter is available. No CPU fallback was started.';return;}
  const device=await adapter.requestDevice();device.destroy();signal.throwIfAborted();compatible=true;
  node('device').textContent='GPU capability check passed. Model compatibility and speed are still untested.';
  status('Choose the download or a previously saved model.');
}));
consent.addEventListener('change',update);
buttons.download.addEventListener('click',()=>void task(async(signal,ticket)=>{
  model=undefined;progress.value=0;status('Downloading and verifying the selected model…');
  const value=await downloadModel(consent.checked,signal,b=>{if(ticket===epoch)advance(b)});signal.throwIfAborted();
  if(ticket===epoch){model=value;status('Model verified. Choose a fixed test when you are ready.');}
}));
buttons.saved.addEventListener('click',()=>void task(async(signal,ticket)=>{
  model=undefined;progress.value=0;status('Verifying saved model bytes…');
  const value=await savedModel(signal,b=>{if(ticket===epoch)advance(b)});signal.throwIfAborted();
  if(ticket===epoch){model=value;status('Saved model verified. Choose a fixed test.');}
}));
buttons.remove.addEventListener('click',()=>void task(async(signal,ticket)=>{
  model=undefined;await engine.stop();signal.throwIfAborted();await removeModel();signal.throwIfAborted();
  if(ticket!==epoch)return;progress.value=0;
  node('model').textContent='Optional model removed. Other website storage was not changed.';status('No model loaded.');
}));
const fixtures={general:'Explain the difference between a Python list and tuple in three clear sentences.',coding:'Write a Python function is_even(n) that returns True for even integers and False otherwise. Return only the function.'};
for(const [name,prompt] of Object.entries(fixtures))buttons[name].addEventListener('click',()=>void task(async(signal,ticket)=>{
  if(!model||!compatible)return;
  node('answer').textContent='';node('metrics').replaceChildren();
  const result=await engine.run(model,prompt,{signal,
    onText:text=>{if(ticket===epoch&&!signal.aborted)node('answer').textContent=text},
    onStatus:message=>{if(ticket===epoch&&!signal.aborted)status({starting:'Starting a fresh worker…',loading:'Loading the model and checking GPU execution…',generating:'Generating on this device…',stopping:'Unloading the worker…'}[message])},
  });
  signal.throwIfAborted();if(ticket!==epoch)return;
  for(const [label,value] of Object.entries(result)){
    const key=document.createElement('dt'),item=document.createElement('dd');key.textContent=label;item.textContent=typeof value==='number'?String(Math.round(value*1000)/1000):String(value);
    node('metrics').append(key,item);
  }
  status('Test finished and worker unloaded. Review the answer and measurements; a length stop means the answer is incomplete.');
}));
async function stop(){
  const ticket=++epoch;active?.abort();active=undefined;
  try{
    await engine.stop();
    if(ticket===epoch)status('Stopped and unload requested. A new test waits for any outstanding loader cleanup.');
  }catch{if(ticket===epoch)status('Device cleanup could not be confirmed. Reload this prototype before another test.');}
  finally{if(ticket===epoch)update();}
}
buttons.stop.addEventListener('click',()=>void stop());
buttons.clear.addEventListener('click',()=>void(async()=>{if(active)await stop();node('answer').textContent='';node('metrics').replaceChildren();})());
addEventListener('pagehide',()=>{active?.abort();void engine.stop()});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&active)void stop()});
update();
