import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadModel, savedModel, removeModel, manifest, modelUrl, storeName} from '../src/model-store.ts';

const filename=`${manifest.sha256}.gguf`;
const pinnedUrl='https://huggingface.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive/resolve/2bcf35c1ebf62c837c12c1aa90b578ff4717e831/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf';
const spare=64*1024*1024;

// This fixture never downloads or allocates the 1.3 GB model. Actual manifest
// preconditions and failed tiny streams exercise storage cleanup; the separate
// integrity test file covers complete verified writes with 35 byte fixtures.
function environment(t,{estimate={quota:manifest.bytes+spare+1024,usage:0},
    existingSize=17,fetchResponse,fetchError,abortWriterError=false,lockAvailable=true}={}){
  const events=[];
  const session={unchanged:true};
  const unrelated={unchanged:true};
  const files=new Map([['unrelated-file',unrelated]]);
  if(existingSize!==null)files.set(filename,{size:existingSize});
  const roots=new Map([[storeName,files],['account-session-store',session]]);
  let resolveOpened;
  const opened=new Promise(resolve=>{resolveOpened=resolve;});
  let savedStreamReads=0;
  const writer={
    async write(chunk){events.push(['write',chunk.byteLength]);},
    async close(){events.push(['close']);},
    async abort(){events.push(['abort']);if(abortWriterError)throw Error('Mock abort failed');},
  };
  const dir={
    async getFileHandle(name,options){
      events.push(['file',name,options]);
      if(!files.has(name)&&!options?.create)throw new DOMException('Missing file','NotFoundError');
      if(options?.create&&!files.has(name))files.set(name,{size:0});
      return {
        async getFile(){
          events.push(['getFile',name]);
          return {size:files.get(name)?.size,stream(){savedStreamReads++;throw Error('Unexpected saved-model stream');}};
        },
        async createWritable(){events.push(['writer',name]);resolveOpened();return writer;},
      };
    },
    async removeEntry(name){events.push(['removeFile',name]);files.delete(name);},
  };
  const root={
    async getDirectoryHandle(name,options){events.push(['directory',name,options]);assert.equal(name,storeName);return dir;},
    async removeEntry(name,options){events.push(['removeDirectory',name,options]);roots.delete(name);},
  };
  const storage={
    async estimate(){events.push(['estimate']);return estimate;},
    async getDirectory(){events.push(['root']);return root;},
  };
  const definitions={
    navigator:{configurable:true,value:{storage,locks:{async request(name,options,action){
      events.push(['lock',name,options]);
      assert.equal(name,storeName);
      assert.deepEqual(options,{mode:'exclusive',ifAvailable:true});
      return action(lockAvailable?{name}:null);
    }}}},
    fetch:{configurable:true,writable:true,value:async(url,options)=>{
      events.push(['fetch',url,options]);
      if(fetchError)throw fetchError;
      return fetchResponse??{ok:false,body:null};
    }},
    localStorage:{configurable:true,get(){throw Error('Chat/session localStorage must not be touched');}},
    sessionStorage:{configurable:true,get(){throw Error('Chat/session sessionStorage must not be touched');}},
    indexedDB:{configurable:true,get(){throw Error('Chat/session IndexedDB must not be touched');}},
  };
  for(const [name,definition]of Object.entries(definitions)){
    const original=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,definition);
    t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else delete globalThis[name];});
  }
  return {events,files,roots,session,unrelated,opened,get savedStreamReads(){return savedStreamReads;}};
}

const count=(env,event)=>env.events.filter(entry=>entry[0]===event).length;
function unrelatedStoragePreserved(env){
  assert.strictEqual(env.roots.get('account-session-store'),env.session);
  assert.strictEqual(env.files.get('unrelated-file'),env.unrelated);
}

// Top-level tests use the default sequential execution because browser globals
// are mocked and restored after every test.
test('download needs explicit boolean consent before storage or network access',async t=>{
  const env=environment(t);
  for(const consent of [false,undefined,null,'true',1]){
    await assert.rejects(downloadModel(consent,new AbortController().signal,()=>{}),/Choose the model download/);
  }
  assert.deepEqual(env.events,[]);
  unrelatedStoragePreserved(env);
});

test('insufficient available quota prevents a download and leaves existing files intact',async t=>{
  const usage=4194304;
  const env=environment(t,{estimate:{quota:usage+manifest.bytes+spare-1,usage}});
  await assert.rejects(downloadModel(true,new AbortController().signal,()=>{}),/Not enough estimated device storage/);
  assert.deepEqual(env.events.map(e=>e[0]),['lock','estimate']);
  assert.equal(env.files.has(filename),true);
  unrelatedStoragePreserved(env);
});

test('an already aborted request opens no storage and makes no network request',async t=>{
  const env=environment(t);const controller=new AbortController();controller.abort();
  await assert.rejects(downloadModel(true,controller.signal,()=>{}),{name:'AbortError'});
  assert.deepEqual(env.events.map(e=>e[0]),['lock']);
});

test('missing, nonfinite and negative storage estimates fail closed before storage or network',async t=>{
  const estimate={quota:0,usage:0};const env=environment(t,{estimate});
  for(const value of [{quota:undefined,usage:0},{quota:NaN,usage:0},
    {quota:Infinity,usage:0},{quota:manifest.bytes*2,usage:NaN},
    {quota:manifest.bytes*2,usage:undefined},{quota:-1,usage:0},
    {quota:manifest.bytes*2,usage:-1}]){
    Object.assign(estimate,value);
    await assert.rejects(downloadModel(true,new AbortController().signal,()=>{}),/could not be estimated safely/);
  }
  assert.equal(count(env,'fetch'),0);
  assert.equal(count(env,'root'),0);
  unrelatedStoragePreserved(env);
});

test('a model lock held in another tab rejects every cache operation without touching storage',async t=>{
  const env=environment(t,{lockAvailable:false});
  for(const action of [()=>downloadModel(true,new AbortController().signal,()=>{}),
    ()=>savedModel(new AbortController().signal,()=>{}),()=>removeModel()]){
    await assert.rejects(action(),/model is in use in another tab/);
  }
  assert.deepEqual(env.events.map(e=>e[0]),['lock','lock','lock']);
  assert.equal(env.files.has(filename),true);
  unrelatedStoragePreserved(env);
});

test('browsers without safe model locking fail before storage or network access',async t=>{
  const env=environment(t);delete navigator.locks;
  for(const action of [()=>downloadModel(true,new AbortController().signal,()=>{}),
    ()=>savedModel(new AbortController().signal,()=>{}),()=>removeModel()]){
    await assert.rejects(action(),/Safe model storage locking is unavailable/);
  }
  assert.deepEqual(env.events,[]);
  unrelatedStoragePreserved(env);
});

test('model download uses only the exact pinned public artifact without account cookies or headers',async t=>{
  const env=environment(t);
  const controller=new AbortController();
  await assert.rejects(downloadModel(true,controller.signal,()=>{}),/Model download failed/);
  assert.equal(modelUrl,pinnedUrl);
  assert.match(manifest.revision,/^[a-f0-9]{40}$/);
  const calls=env.events.filter(entry=>entry[0]==='fetch');
  assert.equal(calls.length,1);
  assert.equal(calls[0][1],pinnedUrl);
  assert.deepEqual(calls[0][2],{signal:controller.signal,credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
  assert.equal(count(env,'writer'),0);
  unrelatedStoragePreserved(env);
});

test('fetch failure preserves an existing model and all other origin storage',async t=>{
  const failure=new TypeError('Synthetic offline condition');
  const env=environment(t,{existingSize:manifest.bytes,fetchError:failure});
  await assert.rejects(downloadModel(true,new AbortController().signal,()=>{}),error=>error===failure);
  assert.deepEqual(env.events.filter(e=>e[0].startsWith('remove')),[]);
  assert.equal(count(env,'writer'),0);
  assert.equal(env.files.has(filename),true);
  unrelatedStoragePreserved(env);
});

test('a failed replacement aborts its writer and preserves the previous model entry',async t=>{
  const body=new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.close();}});
  const env=environment(t,{existingSize:manifest.bytes,fetchResponse:{ok:true,body,headers:new Headers()}});
  await assert.rejects(downloadModel(true,new AbortController().signal,()=>{}),/Model download is incomplete/);
  assert.equal(count(env,'abort'),1);
  assert.equal(count(env,'close'),0);
  assert.deepEqual(env.events.filter(e=>e[0].startsWith('remove')),[]);
  assert.equal(env.files.get(filename).size,manifest.bytes);
  unrelatedStoragePreserved(env);
});

test('unexpected remote length never creates a writer or deletes an existing model',async t=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const env=environment(t,{fetchResponse:{ok:true,body,headers:new Headers({'content-length':String(manifest.bytes-1)})}});
  await assert.rejects(downloadModel(true,new AbortController().signal,()=>{}),/Remote model size does not match/);
  assert.equal(count(env,'writer'),0);
  assert.deepEqual(env.events.filter(e=>e[0].startsWith('remove')),[]);
  assert.equal(env.files.has(filename),true);
  assert.equal(cancelled,true,'The download must cancel its rejected response body itself');
  unrelatedStoragePreserved(env);
});

test('a rejected HTTP response cancels its body before returning without opening a writer',async t=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const env=environment(t,{existingSize:null,fetchResponse:{ok:false,status:503,body,headers:new Headers()}});
  await assert.rejects(downloadModel(true,new AbortController().signal,()=>{}),/Model download failed/);
  assert.equal(cancelled,true);
  assert.equal(count(env,'writer'),0);
  assert.equal(count(env,'write'),0);
  assert.equal(count(env,'close'),0);
  assert.deepEqual(env.events.filter(e=>e[0].startsWith('remove')),[]);
  unrelatedStoragePreserved(env);
});

test('incomplete tiny body aborts the writer without closing or keeping a partial model',async t=>{
  const body=new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.close();}});
  const env=environment(t,{existingSize:null,fetchResponse:{ok:true,body,headers:new Headers({'content-length':String(manifest.bytes)})}});
  await assert.rejects(downloadModel(true,new AbortController().signal,()=>{}),/Model download is incomplete/);
  assert.equal(count(env,'write'),0);
  assert.equal(count(env,'close'),0);
  assert.equal(count(env,'abort'),1);
  assert.equal(env.files.has(filename),false);
  assert.deepEqual(env.events.filter(e=>e[0].startsWith('remove')),[['removeFile',filename]]);
  unrelatedStoragePreserved(env);
});

test('abort cancels a stalled stream and removes the model even if writer abort itself fails',async t=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const env=environment(t,{existingSize:null,abortWriterError:true,fetchResponse:{ok:true,body,headers:new Headers()}});
  const controller=new AbortController();
  const pending=downloadModel(true,controller.signal,()=>{});
  await env.opened;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(cancelled,true);
  assert.equal(count(env,'close'),0);
  assert.equal(count(env,'abort'),1);
  assert.equal(count(env,'write'),0);
  assert.equal(env.files.has(filename),false);
  unrelatedStoragePreserved(env);
});

test('saved incomplete model fails before streaming and never silently downloads a replacement',async t=>{
  const env=environment(t,{existingSize:manifest.bytes-1});
  await assert.rejects(savedModel(new AbortController().signal,()=>{}),/Saved model is incomplete/);
  assert.equal(env.savedStreamReads,0);
  assert.equal(count(env,'fetch'),0);
  assert.equal(count(env,'writer'),0);
  assert.equal(env.files.has(filename),true);
  unrelatedStoragePreserved(env);
});

test('explicit model removal deletes only the dedicated model directory',async t=>{
  const env=environment(t);
  await removeModel();
  assert.deepEqual(env.events.map(e=>e[0]),['lock','root','removeDirectory']);
  assert.deepEqual(env.events[2],['removeDirectory',storeName,{recursive:true}]);
  assert.equal(env.roots.has(storeName),false);
  assert.strictEqual(env.roots.get('account-session-store'),env.session);
});
