/** Parse SSE across arbitrary network/UTF-8 boundaries. Never persist stream data. */
export async function* readEvents(body:ReadableStream<Uint8Array>){
  const limit=1_048_576,reader=body.getReader(),decoder=new TextDecoder();let pending='',data:string[]=[],size=0;
  function append(value:string){size+=value.length+(data.length?1:0);if(size>limit)throw Error('The model stream exceeded its frame size.');data.push(value)}
  try{
    while(true){
      const {done,value}=await reader.read();pending+=done?decoder.decode():decoder.decode(value,{stream:true});
      let end:number;
      while((end=pending.indexOf('\n'))>=0){
        if(end>limit)throw Error('The model stream exceeded its frame size.');
        const line=pending.slice(0,end).replace(/\r$/,'');pending=pending.slice(end+1);
        if(!line){if(data.length){yield data.join('\n');data=[];size=0}}
        else if(line.startsWith('data:'))append(line.slice(5).replace(/^ /,''));
      }
      if(pending.length>limit)throw Error('The model stream exceeded its frame size.');
      if(done){if(pending.startsWith('data:'))append(pending.slice(5).trimStart());if(data.length)yield data.join('\n');break}
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
