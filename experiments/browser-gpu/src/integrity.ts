export interface ChunkManifest {bytes:number;chunkBytes:number;chunks:readonly string[]}
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');

// Hash bounded 16 MiB blocks, never a second 1.3 GB ArrayBuffer. The ordered
// manifest is derived from the checksum-verified original Samsung artifact.
export async function verifyStream(
  stream:ReadableStream<Uint8Array>, manifest:ChunkManifest,
  {signal,onChunk,onProgress,digest=async(data:Uint8Array)=>hex(await crypto.subtle.digest('SHA-256',data as Uint8Array<ArrayBuffer>))}:
  {signal?:AbortSignal;onChunk?:(data:Uint8Array)=>Promise<void>;onProgress?:(bytes:number)=>void;
    digest?:(data:Uint8Array)=>Promise<string>}={},
):Promise<number>{
  if(!Number.isSafeInteger(manifest.bytes)||manifest.bytes<1||!Number.isSafeInteger(manifest.chunkBytes)||manifest.chunkBytes<1||
    manifest.chunks.length!==Math.ceil(manifest.bytes/manifest.chunkBytes)||manifest.chunks.some(h=>!/^[a-f0-9]{64}$/.test(h)))throw Error('Invalid model manifest.');
  const reader=stream.getReader();let total=0,index=0,used=0,complete=false;
  let block=new Uint8Array(Math.min(manifest.chunkBytes,manifest.bytes));
  const abort=()=>void reader.cancel().catch(()=>{});
  signal?.addEventListener('abort',abort,{once:true});
  try{
    signal?.throwIfAborted();
    for(;;){
      const item=await reader.read();signal?.throwIfAborted();
      if(item.done)break;
      let offset=0;const value=item.value;
      if(total+value.byteLength>manifest.bytes)throw Error('Model size does not match the selected checkpoint.');
      while(offset<value.byteLength){
        const size=Math.min(block.length-used,value.byteLength-offset);
        block.set(value.subarray(offset,offset+size),used);used+=size;offset+=size;total+=size;
        if(used===block.length){
          const hash=await digest(block);signal?.throwIfAborted();
          if(hash!==manifest.chunks[index])throw Error('Model integrity check failed.');
          await onChunk?.(block);signal?.throwIfAborted();onProgress?.(total);index++;used=0;
          if(total<manifest.bytes)block=new Uint8Array(Math.min(manifest.chunkBytes,manifest.bytes-total));
        }
      }
    }
    if(total!==manifest.bytes||used!==0||index!==manifest.chunks.length)throw Error('Model download is incomplete.');
    complete=true;return total;
  }finally{
    signal?.removeEventListener('abort',abort);
    if(!complete)await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
