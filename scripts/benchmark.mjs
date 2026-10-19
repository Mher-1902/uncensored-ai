import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readEvents} from '../src/stream.ts';
import {segmentMaxTokens} from '../src/reply-settings.ts';

const prompt='Explain in three short sentences why seasons happen on Earth.';
const requestHeaders={'Content-Type':'application/json','X-Offscript-Client':'web'};
const validId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
class BenchmarkFailure extends Error{constructor(code){super('Synthetic benchmark did not complete.');this.code=code}}
const fail=code=>{throw new BenchmarkFailure(code)};
function apiURL(value){
  let url;try{url=new URL(value)}catch{throw Error('Invalid benchmark API address.')}
  if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('Use an HTTPS API or a loopback HTTP API without embedded credentials.');
  return url.href.replace(/\/$/,'');
}

// Text stays in this invocation's memory solely to continue the actual assistant
// prefix. Returned reports contain timings/counts/status codes, never content.
export async function benchmarkSample({apiBase,reasoned=false,accessToken=null,accountControl=false,fetchImpl=fetch,now=()=>performance.now(),signal,timeoutMs=600000,maxSegments=16}={}){
  const base=apiURL(apiBase);
  if(!Number.isInteger(maxSegments)||maxSegments<1||maxSegments>16||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw Error('Use 1–16 segments and a bounded answer timeout.');
  if(accessToken!==null&&(typeof accessToken!=='string'||!accessToken||/[\r\n]/.test(accessToken)))throw Error('Invalid benchmark credential.');
  const headers={...requestHeaders,...(accessToken?{Authorization:`Bearer ${accessToken}`}:{})};
  const deadline=AbortSignal.timeout(timeoutMs),requestSignal=signal?AbortSignal.any([signal,deadline]):deadline;
  const start=now(),segments=[];
  let firstToken=null,firstAnswer=null,text='',answerId=null,receipt=null,completed=false,incompleteReason=null,cancellationAttempted=false;
  try{
    for(let index=0;index<maxSegments;index++){
      requestSignal.throwIfAborted();
      const continuation=index>0,deep=reasoned&&!continuation,maxTokens=segmentMaxTokens(accountControl,deep);
      if(continuation&&(accountControl||answerId)&&(!answerId||!receipt))fail('missing_receipt');
      const messages=[{role:'user',content:prompt},...(continuation?[{role:'assistant',content:text}]:[])];
      const segmentStart=now();
      const row={index:index+1,continuation,mode:deep?'deep':'fast',requestedMaxTokens:maxTokens,httpStatus:null,firstTokenMs:null,firstAnswerMs:null,totalMs:null,completionTokens:null,decodeTokensPerSecond:null,finishReason:null,done:false};
      segments.push(row);
      let segmentText='',nextReceipt=null,receivedAnswer=false,lastToken=null;
      try{
        const response=await fetchImpl(`${base}/chat`,{method:'POST',headers,redirect:'error',cache:'no-store',signal:requestSignal,
          body:JSON.stringify({messages,maxTokens,mode:deep?'deep':'fast',reasoned:deep,...(continuation?{continuation:true,...(answerId?{answerId,receipt}:{})}:{})})});
        row.httpStatus=response.status;
        if(!response.ok){await response.body?.cancel();fail(response.status===422?'context_limit':'http_error')}
        if(!response.body||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='text/event-stream'){await response.body?.cancel();fail('invalid_stream')}
        for await(const data of readEvents(response.body)){
          requestSignal.throwIfAborted();
          if(data==='[DONE]'){row.done=true;break}
          let event;try{event=JSON.parse(data)}catch{fail('invalid_stream')}
          if(!event||typeof event!=='object')fail('invalid_stream');
          if(event.error)fail('model_error');
          if(event.answer!==undefined){
            if(!validId(event.answer?.id)||(answerId&&answerId!==event.answer.id)||(event.answer.receipt!==undefined&&!validId(event.answer.receipt)))fail('invalid_answer_identity');
            answerId=event.answer.id;receivedAnswer=true;
            if(event.answer.receipt!==undefined){if(nextReceipt)fail('invalid_answer_identity');nextReceipt=event.answer.receipt}
          }
          const choice=event.choices?.[0],delta=choice?.delta;
          if((delta?.content!==undefined&&typeof delta.content!=='string')||(delta?.reasoning_content!==undefined&&typeof delta.reasoning_content!=='string'))fail('invalid_stream');
          if(delta?.content||delta?.reasoning_content){
            const stamp=now();firstToken??=stamp-start;row.firstTokenMs??=stamp-segmentStart;lastToken=stamp-segmentStart;
            if(delta.content){
              firstAnswer??=stamp-start;row.firstAnswerMs??=stamp-segmentStart;segmentText+=delta.content;
              if(text.length+segmentText.length>65536)fail('answer_size_limit');
            }
          }
          if(choice?.finish_reason){
            const reason=['stop','length'].includes(choice.finish_reason)?choice.finish_reason:'other';
            if(row.finishReason&&row.finishReason!==reason)fail('invalid_finish_reason');row.finishReason=reason;
          }
          if(event.usage?.completion_tokens!==undefined){
            const tokens=event.usage.completion_tokens;
            if(!Number.isInteger(tokens)||tokens<0||tokens>4096)fail('invalid_usage');row.completionTokens=tokens;
          }
        }
        if(!row.done)fail('stream_ended');
        if((accountControl||answerId)&&!receivedAnswer)fail('missing_answer_identity');
        text+=segmentText;
        if(row.finishReason==='stop'){
          if(!text.trim())fail('no_visible_answer');
          if(nextReceipt)fail('invalid_answer_identity');
          completed=true;break;
        }
        if(row.finishReason!=='length')fail('missing_natural_stop');
        if(!segmentText)fail('no_progress');
        receipt=nextReceipt;
      }finally{
        row.totalMs=now()-segmentStart;
        if(row.completionTokens>1&&row.firstTokenMs!==null&&lastToken>row.firstTokenMs)row.decodeTokensPerSecond=(row.completionTokens-1)/((lastToken-row.firstTokenMs)/1000);
      }
    }
    if(!completed)fail('segment_limit');
  }catch(error){
    incompleteReason=requestSignal.aborted?(signal?.aborted?'cancelled':'deadline'):error instanceof BenchmarkFailure?error.code:'transport_error';
  }finally{
    if(answerId&&!completed){
      cancellationAttempted=true;
      try{
        const response=await fetchImpl(`${base}/answer/cancel`,{method:'POST',headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000),body:JSON.stringify({answerId})});
        await response.body?.cancel();
      }catch{/* Cancellation is attempted; this report cannot certify worker cleanup. */}
    }
  }
  const usageComplete=segments.length>0&&segments.every(row=>row.completionTokens!==null);
  const decodeSegments=segments.filter(row=>row.decodeTokensPerSecond!==null);
  return {outcome:completed?'completed':'incomplete',incompleteReason,ttftMs:firstToken,firstAnswerMs:firstAnswer,totalMs:now()-start,
    completionTokens:usageComplete?segments.reduce((sum,row)=>sum+row.completionTokens,0):null,
    decodeTokensPerSecond:usageComplete&&decodeSegments.length===segments.length?decodeSegments.reduce((sum,row)=>sum+row.completionTokens-1,0)/decodeSegments.reduce((sum,row)=>(row.completionTokens-1)/row.decodeTokensPerSecond+sum,0):null,
    cancellationAttempted,segments};
}

function quantile(values,q){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*q)-1)]:null}
export function summarizeBenchmark(samples){
  const completed=samples.filter(sample=>sample.outcome==='completed');
  const failures={};for(const sample of samples)if(sample.outcome!=='completed')failures[sample.incompleteReason]=(failures[sample.incompleteReason]||0)+1;
  const timings=values=>({observations:values.filter(Number.isFinite).length,p50:quantile(values,.5),p95:values.filter(Number.isFinite).length>=20?quantile(values,.95):null});
  return {completed:completed.length,incomplete:samples.length-completed.length,incompleteReasons:failures,
    ttftMs:timings(samples.map(sample=>sample.ttftMs)),firstAnswerMs:timings(samples.map(sample=>sample.firstAnswerMs)),
    completedAnswerMs:timings(completed.map(sample=>sample.totalMs)),decodeTokensPerSecond:{p50:quantile(completed.map(sample=>sample.decodeTokensPerSecond),.5)}};
}

async function main(){
  const count=Number(process.env.BENCH_RUNS||5),concurrency=Number(process.env.BENCH_CONCURRENCY||1);
  if(!Number.isInteger(count)||count<1||count>100||!Number.isInteger(concurrency)||concurrency<1||concurrency>32)throw Error('Use 1–100 runs and 1–32 clients. Start with one on the Samsung.');
  const reasoned=process.env.BENCH_REASONED==='true';
  const options={apiBase:process.env.API_BASE||'http://127.0.0.1:8080/api',reasoned,accessToken:process.env.BENCH_ACCESS_TOKEN||null,accountControl:process.env.BENCH_ACCOUNT_CONTROL==='true'};
  console.log('Synthetic benchmark only: no prompts, replies, credentials or visitor data are written. Let the model warm up, then watch temperatures.');
  const firstRequest=await benchmarkSample(options),samples=[];let cursor=0;
  // Avoid repeatedly calling a route whose initial request already failed.
  if(firstRequest.outcome==='completed')await Promise.all(Array.from({length:concurrency},async()=>{while(cursor++<count)samples.push(await benchmarkSample(options))}));
  const report={schemaVersion:3,timestamp:new Date().toISOString(),syntheticCase:'seasons-three-sentences-v1',runs:samples.length,concurrency,mode:reasoned?'deep':'fast',accountControl:options.accountControl,limits:{answerTimeoutMs:600000,maxSegments:16,requestedSegmentMaxTokens:{initial:segmentMaxTokens(options.accountControl,reasoned),continuation:segmentMaxTokens(options.accountControl,false)}},firstRequest,...summarizeBenchmark(samples),samples,
    note:'The first request is reported separately; summary statistics cover the remaining warm samples. Natural completion requires finish_reason=stop and DONE after automatic continuations. Segment limits report client requests; server prompt/context guards may use lower budgets, and Deep has a separate hidden-thinking allowance. Segment timings include queue/prefill/cleanup; first answer means visible text. Stream-derived decode rate is approximate, includes hidden thinking and excludes between-segment gaps; chunks may contain multiple tokens. Only completed answers enter completedAnswerMs. p95 is withheld below 20 observations. This fixed synthetic case does not establish answer quality, cold model-load time, capacity or a latency SLA.'};
  console.log(JSON.stringify(report,null,2));
  if(firstRequest.outcome!=='completed'||samples.some(sample=>sample.outcome!=='completed'))process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
