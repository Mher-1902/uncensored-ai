import test from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkSample,summarizeBenchmark} from '../scripts/benchmark.mjs';

const apiBase='http://127.0.0.1:8080/api';
const frame=event=>`data: ${JSON.stringify(event)}\n\n`;
function stream(text,reason,{done=true,usage=3,answer=null,receipt=null,thinking=null}={}){
  const choices=[{delta:{...(thinking?{reasoning_content:thinking}:{}),content:text},finish_reason:reason}];
  return new Response((answer?frame({answer:{id:answer}}):'')+frame({choices})+(usage===null?'':frame({usage:{completion_tokens:usage}}))+(receipt?frame({answer:{id:answer,receipt}}):'')+(done?'data: [DONE]\n\n':''),{headers:{'Content-Type':'text/event-stream'}});
}
function clock(){let value=0;return()=>value+=10}
test('the benchmark distinguishes one naturally stopped answer from DONE-only partial output',async()=>{
  const complete=await benchmarkSample({apiBase,now:clock(),fetchImpl:async()=>stream('Private synthetic text','stop')});
  assert.equal(complete.outcome,'completed');assert.equal(complete.segments[0].finishReason,'stop');assert.equal(complete.segments[0].done,true);assert.equal(complete.completionTokens,3);assert.equal(complete.segments[0].requestedMaxTokens,512);
  const partial=await benchmarkSample({apiBase,fetchImpl:async()=>stream('Private synthetic text',null)});
  assert.equal(partial.outcome,'incomplete');assert.equal(partial.incompleteReason,'missing_natural_stop');assert.notEqual(partial.firstAnswerMs,null);
  assert.doesNotMatch(JSON.stringify([complete,partial]),/Private synthetic text|seasons/);
});
test('length-limited segments continue the exact assistant prefix and think only on the first segment',async()=>{
  const bodies=[];const prefix='Code:\n```js\n  ';
  const result=await benchmarkSample({apiBase,reasoned:true,now:clock(),fetchImpl:async(url,options)=>{
    assert.equal(url,apiBase+'/chat');assert.equal(options.redirect,'error');bodies.push(JSON.parse(options.body));
    return bodies.length===1?stream(prefix,'length',{usage:4,thinking:'hidden synthetic thought'}):stream('return 42;\n```','stop',{usage:5});
  }});
  assert.equal(result.outcome,'completed');assert.equal(result.completionTokens,9);assert.equal(result.segments.length,2);
  assert.equal(bodies[0].mode,'deep');assert.equal(bodies[0].reasoned,true);
  assert.equal(bodies[0].maxTokens,256);assert.deepEqual(result.segments.map(row=>row.requestedMaxTokens),[256,512]);
  assert.deepEqual(bodies[1],{messages:[bodies[0].messages[0],{role:'assistant',content:prefix}],maxTokens:512,mode:'fast',reasoned:false,continuation:true});
  assert.ok(result.totalMs>result.segments[0].totalMs);assert.equal(result.firstAnswerMs,result.ttftMs);
  assert.doesNotMatch(JSON.stringify(result),/hidden synthetic thought|return 42|Code:/);
});
test('hidden thinking and visible first text have distinct timings and usage measures generated tokens',async()=>{
  const result=await benchmarkSample({apiBase,reasoned:true,now:clock(),fetchImpl:async()=>new Response(
    frame({choices:[{delta:{reasoning_content:'private thought'}}]})+frame({choices:[{delta:{content:'private answer'},finish_reason:'stop'}]})+frame({usage:{completion_tokens:3}})+'data: [DONE]\n\n',
    {headers:{'Content-Type':'text/event-stream'}})});
  assert.equal(result.outcome,'completed');assert.equal(result.ttftMs,20);assert.equal(result.firstAnswerMs,30);
  assert.equal(result.segments[0].firstTokenMs,10);assert.equal(result.segments[0].firstAnswerMs,20);assert.equal(result.decodeTokensPerSecond,200);
  assert.doesNotMatch(JSON.stringify(result),/private thought|private answer/);
});
test('full-answer elapsed time includes continuation gaps while observed decode rates use segment windows',async()=>{
  const ticks=[0,10,20,30,40,1000,1010,1020,1030,1040];let calls=0;
  const result=await benchmarkSample({apiBase,now:()=>ticks.shift(),fetchImpl:async()=>new Response(
    frame({choices:[{delta:{content:'A'}}]})+frame({choices:[{delta:{content:'B'},finish_reason:++calls===1?'length':'stop'}]})+frame({usage:{completion_tokens:3}})+'data: [DONE]\n\n',
    {headers:{'Content-Type':'text/event-stream'}})});
  assert.equal(result.outcome,'completed');assert.equal(result.totalMs,1040);assert.equal(result.completionTokens,6);
  assert.ok(Math.abs(result.decodeTokensPerSecond-200)<0.000001);assert.deepEqual(result.segments.map(row=>row.totalMs),[30,30]);
});
test('a later HTTP failure is incomplete, preserves segment metrics and never echoes diagnostics',async()=>{
  let calls=0;
  const result=await benchmarkSample({apiBase,fetchImpl:async()=>++calls===1?stream('Private partial','length'):Response.json({error:'credential=PRIVATE'},{status:503})});
  assert.equal(calls,2);assert.equal(result.outcome,'incomplete');assert.equal(result.incompleteReason,'http_error');assert.equal(result.segments[1].httpStatus,503);assert.equal(result.completionTokens,null);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|Private partial/);
  const summary=summarizeBenchmark([result]);assert.equal(summary.completed,0);assert.equal(summary.incomplete,1);assert.deepEqual(summary.completedAnswerMs,{observations:0,p50:null,p95:null});
});
test('broken streams, unsupported finish reasons and empty answers never certify completion',async()=>{
  for(const [response,reason] of [[stream('Partial','length',{done:false}),'stream_ended'],[stream('Partial','content_filter'),'missing_natural_stop'],[stream('','stop'),'no_visible_answer'],[stream('','length'),'no_progress'],[new Response('not SSE'),'invalid_stream']]){
    const result=await benchmarkSample({apiBase,fetchImpl:async()=>response});
    assert.equal(result.outcome,'incomplete');assert.equal(result.incompleteReason,reason);
  }
});
test('continuations are bounded and cancellation stops further dispatch without hiding partial metrics',async()=>{
  let calls=0;
  const limited=await benchmarkSample({apiBase,maxSegments:2,fetchImpl:async()=>{calls++;return stream('More ','length')}});
  assert.equal(calls,2);assert.equal(limited.incompleteReason,'segment_limit');assert.equal(limited.segments.length,2);
  const controller=new AbortController();calls=0;
  const stopped=await benchmarkSample({apiBase,signal:controller.signal,fetchImpl:async(_url,options)=>{calls++;assert.equal(JSON.parse(options.body).maxTokens,512);controller.abort();return stream('Partial','length')}});
  assert.equal(calls,1);assert.equal(stopped.outcome,'incomplete');assert.equal(stopped.incompleteReason,'cancelled');
  assert.equal(stopped.segments[0].requestedMaxTokens,512);
});
test('missing token usage is not invented and deadline/transport failures remain content-free',async()=>{
  const noUsage=await benchmarkSample({apiBase,fetchImpl:async()=>stream('Answer','stop',{usage:null})});
  assert.equal(noUsage.outcome,'completed');assert.equal(noUsage.completionTokens,null);assert.equal(noUsage.decodeTokensPerSecond,null);
  const deadline=await benchmarkSample({apiBase,timeoutMs:5,fetchImpl:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return stream('Late answer','stop')}});
  assert.equal(deadline.outcome,'incomplete');assert.equal(deadline.incompleteReason,'deadline');
  const failure=await benchmarkSample({apiBase,fetchImpl:async()=>{throw Error('password=PRIVATE')}});
  assert.equal(failure.incompleteReason,'transport_error');assert.doesNotMatch(JSON.stringify(failure),/password|PRIVATE/);
});
const answerId='55555555-5555-4555-8555-555555555555',receipt='66666666-6666-4666-8666-666666666666';
test('ledger continuations use the issued identity and receipt without reporting either',async()=>{
  const bodies=[];
  const result=await benchmarkSample({apiBase,accountControl:true,accessToken:'dummy-private-session',fetchImpl:async(url,options)=>{
    assert.equal(url,apiBase+'/chat');assert.equal(options.headers.Authorization,'Bearer dummy-private-session');bodies.push(JSON.parse(options.body));
    return bodies.length===1?stream('First ','length',{answer:answerId,receipt}):stream('second','stop',{answer:answerId});
  }});
  assert.equal(result.outcome,'completed');assert.equal(bodies[1].answerId,answerId);assert.equal(bodies[1].receipt,receipt);assert.equal(result.cancellationAttempted,false);
  assert.deepEqual(bodies.map(body=>body.maxTokens),[256,256]);assert.deepEqual(result.segments.map(row=>row.requestedMaxTokens),[256,256]);
  assert.doesNotMatch(JSON.stringify(result),/dummy-private-session|55555555|66666666|First |second/);
});
test('missing ledger receipts settle only the known answer with an independent cancellation signal',async()=>{
  const calls=[];
  const result=await benchmarkSample({apiBase,accountControl:true,fetchImpl:async(url,options)=>{
    calls.push(url);
    if(url.endsWith('/answer/cancel')){assert.deepEqual(JSON.parse(options.body),{answerId});assert.equal(options.signal.aborted,false);return Response.json({state:'finished'})}
    return stream('Partial','length',{answer:answerId});
  }});
  assert.equal(result.outcome,'incomplete');assert.equal(result.incompleteReason,'missing_receipt');assert.equal(result.cancellationAttempted,true);
  assert.deepEqual(calls,[apiBase+'/chat',apiBase+'/answer/cancel']);
});
test('changed identities and missing required identity fail without another inference call',async()=>{
  let cancels=0;
  const changed=await benchmarkSample({apiBase,accountControl:true,fetchImpl:async url=>{
    if(url.endsWith('/answer/cancel')){cancels++;return Response.json({})}
    return new Response(frame({answer:{id:answerId}})+frame({answer:{id:receipt}})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  assert.equal(changed.incompleteReason,'invalid_answer_identity');assert.equal(cancels,1);
  const missing=await benchmarkSample({apiBase,accountControl:true,fetchImpl:async()=>stream('Answer','stop')});
  assert.equal(missing.incompleteReason,'missing_answer_identity');assert.equal(missing.cancellationAttempted,false);
});
test('summary counts failures separately and withholds percentile claims on tiny samples',()=>{
  const complete={outcome:'completed',incompleteReason:null,ttftMs:10,firstAnswerMs:20,totalMs:100,decodeTokensPerSecond:4};
  const incomplete={outcome:'incomplete',incompleteReason:'http_error',ttftMs:null,firstAnswerMs:null,totalMs:1,decodeTokensPerSecond:null};
  const summary=summarizeBenchmark([complete,incomplete]);assert.equal(summary.completed,1);assert.equal(summary.incomplete,1);assert.deepEqual(summary.completedAnswerMs,{observations:1,p50:100,p95:null});
  assert.deepEqual(summary.incompleteReasons,{http_error:1});assert.equal(summarizeBenchmark(Array(20).fill(complete)).completedAnswerMs.p95,100);
});
test('unsafe API addresses, embedded credentials and invalid limits are rejected before dispatch',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('Must not connect')};
  for(const apiBase of ['http://remote.test/api','https://user:secret@server.test/api','https://server.test/api?secret=value'])await assert.rejects(benchmarkSample({apiBase,fetchImpl}));
  for(const settings of [{maxSegments:0},{maxSegments:17},{timeoutMs:0},{timeoutMs:600001},{accessToken:'bad\nvalue'}])await assert.rejects(benchmarkSample({apiBase,fetchImpl,...settings}));
  assert.equal(calls,0);
});
