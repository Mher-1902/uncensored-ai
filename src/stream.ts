/** Parse SSE across arbitrary network/UTF-8 boundaries. Never persist stream data. */
export async function* readEvents(body:ReadableStream<Uint8Array>){
  const reader=body.getReader(),decoder=new TextDecoder();let pending='',data:string[]=[];
  try{
    while(true){
      const {done,value}=await reader.read();pending+=done?decoder.decode():decoder.decode(value,{stream:true});
      let end:number;
      while((end=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,end).replace(/\r$/,'');pending=pending.slice(end+1);
        if(!line){if(data.length){yield data.join('\n');data=[]}}
        else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
      }
      if(pending.length>1_048_576)throw Error('The model stream exceeded its frame size.');
      if(done){if(pending.startsWith('data:'))data.push(pending.slice(5).trimStart());if(data.length)yield data.join('\n');break}
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
