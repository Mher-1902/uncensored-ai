export class RequestError extends Error{constructor(status,message){super(message);this.status=status}}
export function validateRequest(value){
  if(!value||typeof value!=='object'||!Array.isArray(value.messages)||!value.messages.length)throw new RequestError(400,'Send a message first.');
  const mode=value.mode??(typeof value.reasoned==='boolean'?(value.reasoned?'deep':'fast'):null);
  if(!['fast','deep'].includes(mode)||![256,512,1024].includes(value.maxTokens)||(value.reasoned!==undefined&&(typeof value.reasoned!=='boolean'||value.reasoned!==(mode==='deep'))))throw new RequestError(400,'Invalid reply settings.');
  const messages=value.messages.map((m,i)=>{
    if(!m||m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'||!m.content.trim())throw new RequestError(400,'Invalid conversation. Clear the chat and try again.');
    return {role:m.role,content:m.content.trim()};
  });
  if(messages.length%2===0)throw new RequestError(400,'The last message must be a question.');
  return {messages,maxTokens:value.maxTokens,mode};
}
