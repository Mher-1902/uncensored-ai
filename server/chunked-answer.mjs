import {readEvents} from '../src/stream.ts';

// Reuse exists only inside one exclusively held gateway request. The caller
// still disposes the slot before DONE, failure, cancellation or another user.
export async function chunkedAnswer({prepared,generate,prepare,signal,chunkTokens}) {
  const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
  const failure=()=>Object.assign(Error('The model could not safely complete this answer. The text received so far is kept.'),{status:502});
  const first=await generate(prepared,combined,true);
  async function* events() {
    let current=prepared,response=first,text='',used=0,promptTokens;
    for(let index=0;index<16;index++) {
      combined.throwIfAborted();
      let chunk='',finish,usage,done=false,bytes=0;
      for await(const raw of readEvents(response.body)) {
        combined.throwIfAborted();bytes+=raw.length;
        if(bytes>2097152)throw failure();
        if(raw==='[DONE]'){done=true;break}
        const event=JSON.parse(raw),choice=event.choices?.[0];
        if(event.error || choice?.delta?.reasoning_content)throw failure();
        // The pinned OpenAI-compatible stream starts with role + null content.
        // Empty metadata is not output; non-null payloads must still be text.
        if(choice?.delta?.content!=null) {
          const content=choice.delta.content;
          if(typeof content!=='string' || text.length+chunk.length+content.length>65536)throw failure();
          chunk+=content;
          if(content)yield {choices:[{delta:{content},finish_reason:null}]};
        }
        if(choice?.finish_reason) {
          if(!['stop','length'].includes(choice.finish_reason) || finish&&finish!==choice.finish_reason)throw failure();
          finish=choice.finish_reason;
        }
        if(event.usage!==undefined)usage=event.usage;
      }
      const limit=Math.min(chunkTokens,current.outputBudget);
      if(!done || !finish || !Number.isInteger(usage?.prompt_tokens) || usage.prompt_tokens<0
        || !Number.isInteger(usage?.completion_tokens) || usage.completion_tokens<0 || usage.completion_tokens>limit
        || usage.prompt_tokens+usage.completion_tokens>4096 || finish==='length'&&(!chunk || !usage.completion_tokens))throw failure();
      promptTokens??=usage.prompt_tokens;used+=usage.completion_tokens;text+=chunk;
      if(used>prepared.outputBudget || promptTokens+used>4096)throw failure();
      if(finish==='stop' || used===prepared.outputBudget) {
        yield {choices:[{delta:{},finish_reason:finish}],usage:{prompt_tokens:promptTokens,completion_tokens:used,total_tokens:promptTokens+used}};
        return;
      }
      // Rebuild the exact assistant prefix with the same template. Never trim
      // code whitespace, add a synthetic user turn or restart hidden thinking.
      const messages=prepared.messages.map(message=>({...message}));
      if(prepared.continuationOptions.continue_final_message)messages.at(-1).content+=text;
      else messages.push({role:'assistant',content:text});
      const next=await prepare({messages,maxTokens:prepared.outputBudget-used,mode:'fast',continuation:true},combined);
      if(next.prompt!==current.prompt+chunk)throw failure();
      current=next;response=await generate(current,combined,true);
    }
    throw failure();
  }
  const iterator=events(),encoder=new TextEncoder();let finished=false;
  const body=new ReadableStream({
    async pull(output) {
      try {
        const next=await iterator.next();
        if(next.done){finished=true;output.enqueue(encoder.encode('data: [DONE]\n\n'));output.close();}
        else output.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      }catch(error){controller.abort();finished=true;output.error(error);await iterator.return();}
    },
    async cancel(){controller.abort();if(!finished)await iterator.return();},
  },{highWaterMark:0});
  return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
}
