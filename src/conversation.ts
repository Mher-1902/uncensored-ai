import type {Message} from './api';

// Keep unsuccessful turns visible, but never present an interrupted answer (or
// its unanswered question) to the model as a successfully completed exchange.
export function completedHistory(messages:Message[]):Message[]{
  const history:Message[]=[];
  let question:Message|undefined;
  for(const message of messages){
    if(message.role==='user'){question=message;continue}
    if(question&&message.complete&&(!message.state||message.state==='complete'))history.push(question,message);
    question=undefined;
  }
  return history;
}

export function restoreQuestion(draft:string,question:string):string{
  return draft.trim()?draft:question;
}

export function settleAnswer(messages:Message[],id:string,content:string,state:'complete'|'stopped'|'interrupted'):Message[]{
  return messages.map(message=>message.id===id?{...message,content,state,complete:state==='complete'}:message);
}

// Retrying is an explicit replacement of the latest failed answer. It uses the
// original question/mode/context, and cannot silently discard later turns.
export function retryTurn(messages:Message[],id:string){
  const answer=messages.at(-1);
  if(!answer||answer.id!==id||answer.role!=='assistant'||!['stopped','interrupted'].includes(answer.state||''))return null;
  const question=messages.at(-2);
  if(!question||question.role!=='user'||question.id!==answer.questionId)return null;
  return {question,answer,history:completedHistory(messages.slice(0,-2))};
}
