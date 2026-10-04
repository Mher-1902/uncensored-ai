export type Message = { id:string; role:'user'|'assistant'; content:string; complete?:boolean };
import {readEvents} from './stream';
export type SiteConfig = { space:string|null; apiBase:string|null; model:string; modelUrl:string };
export async function loadConfig():Promise<SiteConfig>{
  const response=await fetch('/config.json',{cache:'no-store'});
  if(!response.ok)throw Error('Could not load the site configuration.');
  const config=await response.json();
  if(config.space&&!/^[\w.-]+\/[\w.-]+$/.test(config.space))throw Error('Invalid model configuration.');
  if(config.apiBase){
    const url=new URL(config.apiBase,location.origin);
    if(url.origin!==location.origin&&url.protocol!=='https:')throw Error('The model connection must use HTTPS.');
    if(url.username||url.password||url.search||url.hash)throw Error('Invalid model connection.');
    config.apiBase=url.href.replace(/\/$/,'');
  }
  return config;
}
async function cloudReply(space:string,messages:Message[],length:number,signal:AbortSignal,onText:(text:string)=>void,onStatus:(text:string)=>void){
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

export async function checkModel(config:SiteConfig):Promise<boolean>{
  if(config.apiBase){try{const r=await fetch(`${config.apiBase}/health`,{cache:'no-store',signal:AbortSignal.timeout(8000)});return r.ok&&(await r.json()).ready===true}catch{return false}}
  return Boolean(config.space);
}
export async function reply(config:SiteConfig,messages:Message[],length:number,reasoned:boolean,signal:AbortSignal,onText:(text:string)=>void,onStatus:(text:string)=>void){
  if(!config.apiBase){if(config.space)return cloudReply(config.space,messages,length,signal,onText,onStatus);throw Error('The model is not connected yet. No message was sent.')}
  const response=await fetch(`${config.apiBase}/chat`,{method:'POST',headers:{'Content-Type':'application/json','X-Offscript-Client':'web'},body:JSON.stringify({messages:messages.map(({role,content})=>({role,content})),maxTokens:length,reasoned}),signal,cache:'no-store'});
  if(!response.ok){const body=await response.json().catch(()=>null);throw Error(body?.error||`The model is unavailable (${response.status}).`)}
  if(!response.body)throw Error('The model returned no stream.');
  let text='',finished=false;
  for await(const data of readEvents(response.body)){
    if(data==='[DONE]'){finished=true;break}
    const event=JSON.parse(data);
    if(event.error)throw Error(event.error);
    if(event.status)onStatus(event.status);
    const delta=event.choices?.[0]?.delta;
    if(delta?.reasoning_content)onStatus('Thinking through your question…');
    if(delta?.content){text+=delta.content;onStatus('Writing a reply…');onText(text)}
    if(event.choices?.[0]?.finish_reason==='length')onStatus('Reply may be incomplete. Choose a longer reply if needed.');
  }
  if(!finished)throw Error('The connection ended before the reply finished. Please try again.');
  if(!text)throw Error('The model produced no final answer. Try Direct mode or a longer reply.');
}
