// Fixed synthetic comparison inside the isolated, resource-bounded model fixture.
// Never accepts a production URL, credential, prompt or account identifier.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {once} from 'node:events';
import {createGateway} from '../server/index.mjs';
import {createLlamaEngine} from '../server/llama-engine.mjs';
import {readEvents} from '../src/stream.ts';

assert.equal(process.env.OFFSCRIPT_TEST_FIXTURE,'isolated-prefill-model');
assert.deepEqual(Object.keys(networkInterfaces()),['lo']);
assert.equal((await readFile('/sys/fs/cgroup/memory.max','utf8')).trim(),String(2500*1024*1024));
assert.equal((await readFile('/sys/fs/cgroup/memory.swap.max','utf8')).trim(),'0');
assert.equal((await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),'100000 100000');
const profile=process.argv[2];assert.ok(['baseline256','candidate512'].includes(profile));
const parts=[],requests=[];let erasures=0;
const sampledFetch=async(url,options)=>{
  assert.equal(url.origin,'http://127.0.0.1:8081');
  if(url.pathname.startsWith('/slots/'))erasures++;
  if(url.pathname!=='/v1/chat/completions')return fetch(url,options);
  // Identical deterministic sampling isolates processing overhead; this does
  // not change deployment sampling or establish model quality.
  const body={...JSON.parse(options.body),temperature:0,seed:42};
  const part={allowance:body.max_tokens,reuse:body.cache_prompt,first_text_s:null,total_s:null,output_tokens:null,cached_tokens:null,finish_reason:null};
  parts.push(part);const began=performance.now();
  const response=await fetch(url,{...options,body:JSON.stringify(body)});
  part.status=response.status;part.content_type=response.headers.get('content-type');part.events=0;
  if(!response.ok)return response;
  const iterator=readEvents(response.body)[Symbol.asyncIterator](),encoder=new TextEncoder();
  const stream=new ReadableStream({
    async pull(output) {
      try {
        const next=await iterator.next();
        if(next.done){output.close();return}
        if(next.value==='[DONE]')part.total_s=(performance.now()-began)/1000;
        else {
          const event=JSON.parse(next.value),choice=event.choices?.[0];
          part.events++;
          if(part.events===1)part.initial_delta=Object.fromEntries(Object.entries(choice?.delta||{}).map(([key,value])=>[key,value===null?'null':typeof value]));
          if(choice?.delta?.reasoning_content)part.reasoning_seen=true;
          if(event.error)part.error_seen=true;
          if(choice?.delta?.content&&part.first_text_s===null)part.first_text_s=(performance.now()-began)/1000;
          if(choice?.finish_reason)part.finish_reason=choice.finish_reason;
          if(Number.isInteger(event.usage?.completion_tokens))part.output_tokens=event.usage.completion_tokens;
          if(Number.isInteger(event.usage?.prompt_tokens_details?.cached_tokens))part.cached_tokens=event.usage.prompt_tokens_details.cached_tokens;
        }
        output.enqueue(encoder.encode(`data: ${next.value}\n\n`));
      }catch(error){output.error(error)}
    },async cancel(){await iterator.return();},
  },{highWaterMark:0});
  return new Response(stream,{headers:response.headers,status:response.status});
};
const native=createGateway({engine:createLlamaEngine({origin:'http://127.0.0.1:8081',fetchImpl:sampledFetch}),origins:['http://127.0.0.1:8082'],generationTimeout:245000});
native.listen(8082,'127.0.0.1');await once(native,'listening');
const question='Explain how DNS resolution works in about450words. Cover browser and OS caches, recursive resolvers, root and TLD servers, authoritative servers, TTLs, DNSSEC and a concrete example. Use complete paragraphs. Start directly with the explanation.';
let text='',complete=false,lastText,outputTokens=0;
const began=performance.now();
try {
  for(let i=0;i<4;i++) {
    assert.ok(performance.now()-began<360000);
    const started=performance.now(),messages=[{role:'user',content:question},...(i?[{role:'assistant',content:text}]:[])];
    const response=await fetch('http://127.0.0.1:8082/api/chat',{method:'POST',signal:AbortSignal.timeout(250000),
      headers:{'Content-Type':'application/json','X-Offscript-Client':'web',Origin:'http://127.0.0.1:8082'},
      body:JSON.stringify({messages,maxTokens:profile==='candidate512'?512:256,mode:'fast',...(i?{continuation:true}:{})})});
    assert.equal(response.status,200);
    let first,finish,usage,stopped=false,done=false,part='',maxGap=0,previous;
    for await(const raw of readEvents(response.body)) {
      assert.ok(performance.now()-began<360000);
      if(raw==='[DONE]'){done=true;break}
      const event=JSON.parse(raw);assert.ok(!event.error);
      const choice=event.choices?.[0];
      if(choice?.delta?.content) {
        const stamp=performance.now();first??=stamp;
        if(previous)maxGap=Math.max(maxGap,stamp-previous);
        previous=stamp;part+=choice.delta.content;
        assert.ok(text.length+part.length<65536);
      }
      if(choice?.finish_reason)finish=choice.finish_reason;
      if(event.usage)usage=event.usage;
      if(event.control?.workerStopped===true&&event.control.outcome==='completed')stopped=true;
    }
    assert.ok(done&&stopped&&first&&usage&&['stop','length'].includes(finish));
    assert.ok(Number.isInteger(usage.completion_tokens)&&usage.completion_tokens>0&&usage.completion_tokens<=512);
    outputTokens+=usage.completion_tokens;text+=part;
    requests.push({index:i+1,first_text_s:(first-started)/1000,handoff_gap_s:lastText?(first-lastText)/1000:null,
      max_stream_gap_s:maxGap/1000,total_s:(performance.now()-started)/1000,output_tokens:usage.completion_tokens,finish_reason:finish,cleanup_confirmed:stopped});
    lastText=previous;
    console.log(JSON.stringify({progress:true,profile,request:requests.at(-1)}));
    if(finish==='stop'){complete=true;break}
  }
  assert.ok(complete,'No natural completion within the bounded request count');
  assert.equal(erasures,requests.length*2);
  assert.equal((await readFile('/sys/fs/cgroup/memory.swap.current','utf8')).trim(),'0');
  console.log(JSON.stringify({profile,complete,total_s:(performance.now()-began)/1000,output_tokens:outputTokens,characters:text.length,requests,model_chunks:parts,erasures,
    quality:'not assessed',output_retained:false,external_network:false}));
}catch(error) {
  console.log(JSON.stringify({profile,failed:true,reason:'stream_or_completion_validation',failure_type:error.name,requests,model_chunks:parts,erasures}));process.exitCode=1;
}finally{native.closeAllConnections();native.close();}
