export class RequestError extends Error{constructor(status,message){super(message);this.status=status}}
export function validateRequest(value,{allowBoundedTokens=false}={}){
  if(!value||typeof value!=='object'||!Array.isArray(value.messages)||!value.messages.length)throw new RequestError(400,'Send a message first.');
  const mode=value.mode??(typeof value.reasoned==='boolean'?(value.reasoned?'deep':'fast'):null);
  const validTokens=allowBoundedTokens?Number.isInteger(value.maxTokens)&&value.maxTokens>=1&&value.maxTokens<=1024:[256,512,1024].includes(value.maxTokens);
  if(!['fast','deep'].includes(mode)||!validTokens||(value.reasoned!==undefined&&(typeof value.reasoned!=='boolean'||value.reasoned!==(mode==='deep'))))throw new RequestError(400,'Invalid reply settings.');
  if(value.continuation!==undefined&&typeof value.continuation!=='boolean')throw new RequestError(400,'Invalid continuation.');
  const continuation=value.continuation===true;
  if(continuation&&mode!=='fast')throw new RequestError(400,'Continue the answer without starting another thinking phase.');
  const messages=value.messages.map((m,i)=>{
    if(!m||m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'||!m.content.trim())throw new RequestError(400,'Invalid conversation. Clear the chat and try again.');
    // Whitespace is part of an unfinished assistant prefix (including code).
    return {role:m.role,content:m.role==='assistant'?m.content:m.content.trim()};
  });
  if(continuation?messages.length%2!==0:messages.length%2===0)throw new RequestError(400,continuation?'A continuation must end with the existing assistant answer.':'The last message must be a question.');
  return {messages,maxTokens:value.maxTokens,mode,continuation};
}
