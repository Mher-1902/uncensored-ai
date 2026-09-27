export type Message = { id:string; role:'user'|'assistant'; content:string; complete?:boolean };
export type SiteConfig = { space:string|null; model:string; modelUrl:string };
export async function loadConfig():Promise<SiteConfig>{
  const response=await fetch('/config.json',{cache:'no-store'});
  if(!response.ok)throw Error('Could not load the site configuration.');
  const config=await response.json();
  if(config.space&&!/^[\w.-]+\/[\w.-]+$/.test(config.space))throw Error('Invalid model configuration.');
  return config;
}
export async function reply(space:string,messages:Message[],length:number,signal:AbortSignal,onText:(text:string)=>void,onStatus:(text:string)=>void){
  const {Client}=await import('@gradio/client');
  if(signal.aborted)return;
  const client=await Client.connect(space,{events:['data','status']});
  if(signal.aborted){client.close();return}
  const job=client.submit('/generate',[messages.map(({role,content})=>({role,content})),length]);
  const cancel=()=>{void job.cancel();client.close()};
  signal.addEventListener('abort',cancel,{once:true});
  let received=false;
  try{
    for await(const event of job){
      if(signal.aborted)break;
      if(event.type==='data'){
        const content=(event.data as unknown[])[0];
        if(typeof content!=='string')throw Error('The model sent an invalid reply.');
        received=true;onText(content);
      }
      if(event.type==='status'){
        if(event.stage==='error')throw Error(typeof event.message==='string'?event.message:'The cloud model could not answer.');
        onStatus(event.stage==='pending'?`Waiting for a cloud GPU${typeof event.position==='number'?` · position ${event.position+1}`:''}`:'Writing a reply…');
      }
    }
    if(!received&&!signal.aborted)throw Error('The model returned no answer. It may be waking up or out of free GPU quota.');
  }finally{signal.removeEventListener('abort',cancel);client.close()}
}
