import {readEvents} from '../src/stream.ts';
const url=process.env.API_BASE||'http://127.0.0.1:8080/api';
const count=Number(process.env.BENCH_RUNS||5),concurrency=Number(process.env.BENCH_CONCURRENCY||1);
if(!Number.isInteger(count)||count<1||count>100||!Number.isInteger(concurrency)||concurrency<1||concurrency>32)throw Error('Use 1–100 runs and 1–32 clients. Start with one on the Samsung.');
const reasoned=process.env.BENCH_REASONED==='true';
const prompt='Explain in three short sentences why seasons happen on Earth.';
async function sample(){
  const start=performance.now();let firstToken=null,firstAnswer=null,lastToken=null,usage=null,done=false;
  const r=await fetch(`${url}/chat`,{method:'POST',headers:{'Content-Type':'application/json','X-Offscript-Client':'web'},body:JSON.stringify({messages:[{role:'user',content:prompt}],maxTokens:256,reasoned}),signal:AbortSignal.timeout(600000)});
  if(!r.ok)throw Error(`Benchmark request failed (${r.status}).`);
  for await(const data of readEvents(r.body)){
    if(data==='[DONE]'){done=true;break}
    const event=JSON.parse(data);if(event.error)throw Error(event.error);
    const now=performance.now()-start,delta=event.choices?.[0]?.delta;
    if(delta?.content||delta?.reasoning_content){firstToken??=now;lastToken=now}
    if(delta?.content)firstAnswer??=now;
    if(event.usage)usage=event.usage;
  }
  if(!done||firstAnswer===null)throw Error('The model did not produce a complete final-answer stream.');
  const elapsed=performance.now()-start;
  return {ttftMs:firstToken,firstAnswerMs:firstAnswer,totalMs:elapsed,completionTokens:usage?.completion_tokens??null,decodeTokensPerSecond:usage?.completion_tokens>1&&lastToken>firstToken?(usage.completion_tokens-1)/((lastToken-firstToken)/1000):null};
}
function quantile(values,q){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.max(0,Math.ceil(a.length*q)-1)]:null}
console.log('Synthetic benchmark only: no prompts, replies or visitor data are written. Let the model warm up, then watch temperatures.');
const firstRequest=await sample();const samples=[];let cursor=0;
await Promise.all(Array.from({length:concurrency},async()=>{while(cursor++<count)samples.push(await sample())}));
const report={timestamp:new Date().toISOString(),runs:samples.length,concurrency,mode:reasoned?'reasoned':'direct',firstRequest,ttftMs:{p50:quantile(samples.map(s=>s.ttftMs),.5),p95:quantile(samples.map(s=>s.ttftMs),.95)},firstAnswerMs:{p50:quantile(samples.map(s=>s.firstAnswerMs),.5),p95:quantile(samples.map(s=>s.firstAnswerMs),.95)},totalMs:{p50:quantile(samples.map(s=>s.totalMs),.5),p95:quantile(samples.map(s=>s.totalMs),.95)},decodeTokensPerSecond:{p50:quantile(samples.map(s=>s.decodeTokensPerSecond),.5)},note:'First request includes any pending startup latency, but does not measure process/model-load time before this command. Warm samples include queuing. This measures this machine/route only; use at least 20 samples for a useful p95 after thermal checks.'};
console.log(JSON.stringify(report,null,2));
