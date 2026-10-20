export type Message = { id:string; role:'user'|'assistant'; content:string; complete?:boolean; state?:'streaming'|'complete'|'stopped'|'interrupted'; questionId?:string; reasoned?:boolean };
import {readEvents} from './stream.ts';
export type AuthConfig = {url:string; publishableKey:string; providers:('google'|'github')[]; emailEnabled:boolean};
export type SiteConfig = { space:string|null; apiBase:string|null; model:string; modelUrl:string; requireAuth?:boolean; auth?:AuthConfig|null; accountControl?:boolean; fastReplyTokens?:256|512|768 };
export async function loadConfig():Promise<SiteConfig>{
  const response=await fetch('/config.json',{cache:'no-store'});
  if(!response.ok)throw Error('Could not load the site configuration.');
  const config=await response.json();
  if(config.accountControl!==undefined&&typeof config.accountControl!=='boolean')throw Error('Invalid account configuration.');
  if(config.fastReplyTokens!==undefined&&![256,512,768].includes(config.fastReplyTokens))throw Error('Invalid reply configuration.');
  if(config.space&&!/^[\w.-]+\/[\w.-]+$/.test(config.space))throw Error('Invalid model configuration.');
  if(config.apiBase){
    const url=new URL(config.apiBase,location.origin);
    if(url.origin!==location.origin&&url.protocol!=='https:')throw Error('The model connection must use HTTPS.');
    if(url.username||url.password||url.search||url.hash)throw Error('Invalid model connection.');
    config.apiBase=url.href.replace(/\/$/,'');
  }
  if(config.auth){
    const url=new URL(config.auth.url);
    if(url.origin!==config.auth.url||url.protocol!=='https:'||!/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)||!/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(config.auth.publishableKey))throw Error('Invalid account configuration.');
    if(!Array.isArray(config.auth.providers)||config.auth.providers.some((provider:unknown)=>provider!=='google'&&provider!=='github')||typeof config.auth.emailEnabled!=='boolean')throw Error('Invalid account configuration.');
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
// Each segment has its own request deadline. The next segment continues the
// actual assistant prefix; no synthetic user turn or durable chat is created.
export async function reply(config:SiteConfig,messages:Message[],reasoned:boolean,signal:AbortSignal,onText:(text:string)=>void,onStatus:(text:string)=>void,accessToken?:string|null){
  if(!config.apiBase){if(config.space){await cloudReply(config.space,messages,1024,signal,onText,onStatus);return}throw Error('The model is not connected yet. No message was sent.')}
  if((config.requireAuth||config.accountControl)&&!accessToken)throw Error('Sign in before sending a message.');
  if(accessToken&&new URL(config.apiBase,location.origin).origin!==location.origin)throw Error('Account requests must use this website’s own API.');
  const headers:Record<string,string>={'Content-Type':'application/json','X-Offscript-Client':'web'};
  if(accessToken)headers.Authorization=`Bearer ${accessToken}`;
  const validId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  let text='',answerId:string|null=null,receipt:string|null=null,completed=false;
  try {
  for(let segment=0;segment<16;segment++){
    signal.throwIfAborted();
    const continuation=segment>0;
    const history=messages.map(({role,content})=>({role,content}));
    if(continuation)history.push({role:'assistant',content:text});
    const deep=reasoned&&!continuation;
    if(config.accountControl&&continuation&&(!answerId||!receipt))throw Error('The answer could not be continued safely. The text received so far is kept.');
    const maxTokens=deep?256:config.fastReplyTokens===768?768:config.fastReplyTokens===512?512:256;
    const response=await fetch(`${config.apiBase}/chat`,{method:'POST',headers,body:JSON.stringify({messages:history,maxTokens,mode:deep?'deep':'fast',reasoned:deep,...(continuation?{continuation:true,...(config.accountControl?{answerId,receipt}:{})}:{})}),signal,cache:'no-store'});
    if(!response.ok){
      const body=await response.json().catch(()=>null);
      if(response.status===422)throw Error('This conversation has filled the model context. Your answer so far is kept; start a new chat for another question.');
      throw Error(body?.error||`The model is unavailable (${response.status}).`);
    }
    if(!response.body)throw Error('The model returned no stream.');
    let finished=false,finishReason:string|null=null,segmentText='',nextReceipt:string|null=null,receivedAnswer=false;
    for await(const data of readEvents(response.body)){
      signal.throwIfAborted();
      if(data==='[DONE]'){finished=true;break}
      const event=JSON.parse(data);
      if(event.error)throw Error(event.error);
      if(config.accountControl&&event.answer!==undefined){
        if(!validId(event.answer?.id)||answerId&&event.answer.id!==answerId||event.answer.receipt!==undefined&&!validId(event.answer.receipt))throw Error('The answer could not be verified. The text received so far is kept.');
        answerId=event.answer.id;receivedAnswer=true;
        if(event.answer.receipt!==undefined){
          if(nextReceipt)throw Error('The answer could not be verified. The text received so far is kept.');
          nextReceipt=event.answer.receipt;
        }
      }
      if(event.status)onStatus(event.status);
      const choice=event.choices?.[0],delta=choice?.delta;
      if(delta?.reasoning_content)onStatus('Thinking through your question…');
      if(delta?.content){
        if(typeof delta.content!=='string')throw Error('The model sent an invalid reply.');
        segmentText+=delta.content;
        if(text.length+segmentText.length>65536)throw Error('The answer could not be completed. The text received so far is kept.');
        onStatus('Writing a reply…');onText(text+segmentText);
      }
      if(choice?.finish_reason)finishReason=choice.finish_reason;
    }
    if(!finished)throw Error('The connection ended before the reply finished. The text received so far is kept.');
    if(config.accountControl&&!receivedAnswer)throw Error('The answer could not be verified. The text received so far is kept.');
    text+=segmentText;
    if(finishReason==='stop'){
      if(!text.trim())throw Error('The model produced no final answer. Try Fast mode.');
      completed=true;return;
    }
    if(finishReason!=='length')throw Error('The model did not confirm a complete answer. The text received so far is kept.');
    if(!segmentText)throw Error('The model stopped before writing an answer. Try Fast mode.');
    receipt=nextReceipt;
  }
  throw Error('The model could not finish this answer within the conversation budget. The text received so far is kept.');
  } catch(error) {
    // A proxy can report stream failure before the abort reaches its reader.
    // Preserve Stop as cancellation instead of surfacing a connection error.
    signal.throwIfAborted();throw error;
  } finally {
    if(config.accountControl&&answerId&&!completed){
      // This signal is independent of Stop, including the gap between segments.
      // It carries only the opaque answer ID, never conversation text.
      try {
        const cancellation=await fetch(`${config.apiBase}/answer/cancel`,{method:'POST',headers,body:JSON.stringify({answerId}),signal:AbortSignal.timeout(30000),cache:'no-store',keepalive:true});
        await cancellation.body?.cancel();
      }catch{/* The server retains uncertain work for reconciliation. */}
    }
  }
}
