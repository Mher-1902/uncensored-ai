import manifest from '../model-manifest.json' with {type:'json'};
import {verifyStream} from './integrity.ts';
export {manifest};
export const modelUrl=`https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${manifest.file}`;
export const storeName='offscript-browser-gpu-model-v1';
const fileName=`${manifest.sha256}.gguf`;
type Progress=(bytes:number)=>void;
async function withStoreLock<T>(action:()=>Promise<T>):Promise<T>{
  if(!navigator.locks)throw Error('Safe model storage locking is unavailable.');
  return navigator.locks.request(storeName,{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)throw Error('The optional model is in use in another tab.');
    return action();
  });
}
const directory=async()=>{
  if(!navigator.storage?.getDirectory)throw Error('Private model storage is not supported on this browser.');
  return (await navigator.storage.getDirectory()).getDirectoryHandle(storeName,{create:true});
};
export async function savedModel(signal:AbortSignal,onProgress:Progress):Promise<File>{
  return withStoreLock(async()=>{
  signal.throwIfAborted();
  const handle=await (await directory()).getFileHandle(fileName);
  const file=await handle.getFile();
  if(file.size!==manifest.bytes)throw Error('Saved model is incomplete. Remove it and download again.');
  await verifyStream(file.stream(),manifest,{signal,onProgress});return file;
  });
}
export async function downloadModel(consent:boolean,signal:AbortSignal,onProgress:Progress):Promise<File>{
  if(consent!==true)throw Error('Choose the model download and device storage first.');
  return withStoreLock(async()=>{
  signal.throwIfAborted();
  const estimate=await navigator.storage.estimate();
  if(!Number.isFinite(estimate.quota)||!Number.isFinite(estimate.usage)||estimate.quota!<0||estimate.usage!<0)
    throw Error('Available device storage could not be estimated safely.');
  if(estimate.quota!-estimate.usage!<manifest.bytes+64*1024*1024)
    throw Error('Not enough estimated device storage. Free at least 1.4 GB before downloading.');
  const dir=await directory();let writer:FileSystemWritableFileStream|undefined,response:Response|undefined,created=false,existed=false;
  try{await dir.getFileHandle(fileName);existed=true;}
  catch(error){if(!(error instanceof DOMException)||error.name!=='NotFoundError')throw error;}
  try{
    // No authentication headers, cookies, chats or account identifiers leave the
    // prototype. Hugging Face/CDN still sees ordinary download network data.
    response=await fetch(modelUrl,{signal,credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if(!response.ok||!response.body)throw Error('Model download failed. Try again later.');
    const length=response.headers.get('content-length');
    if(length!==null&&Number(length)!==manifest.bytes)throw Error('Remote model size does not match.');
    const file=await dir.getFileHandle(fileName,{create:true});created=!existed;writer=await file.createWritable();
    await verifyStream(response.body,manifest,{signal,onProgress,onChunk:async(data)=>{await writer!.write(data as Uint8Array<ArrayBuffer>);}});
    signal.throwIfAborted();await writer.close();writer=undefined;
    return file.getFile();
  }catch(error){
    await response?.body?.cancel().catch(()=>{});
    if(writer)await writer.abort().catch(()=>{});
    // This directory contains only the optional model, never sessions/chats.
    if(created)await dir.removeEntry(fileName).catch(()=>{});throw error;
  }
  });
}
export async function removeModel():Promise<void>{
  return withStoreLock(async()=>{
  const root=await navigator.storage.getDirectory();
  await root.removeEntry(storeName,{recursive:true}).catch((error:DOMException)=>{if(error.name!=='NotFoundError')throw error;});
  });
}
