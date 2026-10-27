import type {Message} from './api';

// A stopped answer does not erase what its user said. Keep that context while
// omitting unfinished assistant text, which may be wrong or cut off mid-code.
// Consecutive user turns share one wire message so the API's alternating roles
// stay intact. Labels are transport context only; the visible chat is unchanged.
export function requestHistory(messages:Message[],nextUser:Message):Message[]{
  const history:Message[]=[];
  let pending:Message[]=[];
  function userMessage(current:boolean):Message{
    const latest=pending.at(-1)!;
    if(pending.length===1)return latest;
    const content=pending.map((message,index)=>{
      const label=index===pending.length-1
        ? current?'Current user message':'User message answered below'
        : `Earlier user message ${index+1} (reply not completed)`;
      return `${label}:\n${message.content}`;
    }).join('\n\n');
    return {...latest,content};
  }
  for(const message of messages){
    if(message.role==='user'){pending.push(message);continue}
    if(pending.length&&message.complete&&(!message.state||message.state==='complete')
      &&(!message.questionId||message.questionId===pending.at(-1)!.id)){
      history.push(userMessage(false),message);pending=[];
    }
  }
  pending.push(nextUser);
  history.push(userMessage(true));
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
  return {question,answer,history:messages.slice(0,-2)};
}
