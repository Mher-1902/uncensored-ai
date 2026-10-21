import test from 'node:test';
import assert from 'node:assert/strict';
import {reply,loadConfig} from '../src/api.ts';

const message=[{id:'dummy-question',role:'user',content:'Hello',complete:true}];
function location(t) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{value:{origin:'https://app.test'},configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'location',previous);else delete globalThis.location;});
}
test('signed-in client sends its session only to the same-origin API and preserves streamed text',async t=>{
  location(t);let calls=0,text='';
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls++;assert.equal(url,'https://app.test/api/chat');assert.equal(options.headers.Authorization,'Bearer dummy-session');
    assert.deepEqual(JSON.parse(options.body),{messages:[{role:'user',content:'Hello'}],maxTokens:256,mode:'fast',reasoned:false});
    return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await reply({apiBase:'https://app.test/api',space:null,requireAuth:true},message,false,new AbortController().signal,value=>{text=value},()=>{},'dummy-session');
  assert.equal(text,'Hello');assert.equal(calls,1);
});
test('missing sign-in leaves authenticated chat unsent',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('No request expected.');});
  await assert.rejects(reply({apiBase:'/api',space:null,requireAuth:true},message,false,new AbortController().signal,()=>{},()=>{}),/session expired/);
  assert.equal(calls,0);
});
test('an account session is never sent to a separately configured model origin',async t=>{
  location(t);let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('No request expected.');});
  await assert.rejects(reply({apiBase:'https://model.test/api',space:null,requireAuth:true},message,false,new AbortController().signal,()=>{},()=>{},'dummy-session'),/own API/);
  assert.equal(calls,0);
});
function event(text,reason){return new Response(`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:reason}]})}\n\ndata: [DONE]\n\n`)}
test('a capped segment automatically continues the exact assistant prefix in one answer',async t=>{
  const bodies=[],updates=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    bodies.push(JSON.parse(options.body));
    return bodies.length===1?event('Code:\n```js\n  ','length'):event('return 42;\n```','stop');
  });
  await reply({apiBase:'https://app.test/api',space:null},message,true,new AbortController().signal,value=>updates.push(value),()=>{});
  assert.equal(bodies.length,2);
  assert.equal(bodies[0].mode,'deep');
  assert.deepEqual(bodies[1],{messages:[{role:'user',content:'Hello'},{role:'assistant',content:'Code:\n```js\n  '}],maxTokens:256,mode:'fast',reasoned:false,continuation:true});
  assert.equal(updates.at(-1),'Code:\n```js\n  return 42;\n```');
});
test('a natural stop makes one request even for a short answer',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return event('Done','stop')});
  await reply({apiBase:'https://app.test/api',space:null},message,false,new AbortController().signal,()=>{},()=>{});
  assert.equal(calls,1);
});
test('the reviewed larger request budget is opt-in and never enlarges initial thinking',async t=>{
  for(const reasoned of [false,true]) {
    const bodies=[];
    const mock=t.mock.method(globalThis,'fetch',async(_url,options)=>{
      bodies.push(JSON.parse(options.body));return bodies.length===1?event('Prefix ','length'):event('end','stop');
    });
    await reply({apiBase:'https://app.test/api',space:null,fastReplyTokens:512},message,reasoned,new AbortController().signal,()=>{},()=>{});
    assert.deepEqual(bodies.map(b=>b.maxTokens),reasoned?[256,512]:[512,512]);
    assert.equal(bodies[1].messages.at(-1).content,'Prefix ');mock.mock.restore();
  }
});
test('public reply configuration rejects unbounded or mistyped budgets',async t=>{
  location(t);
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({space:null,apiBase:'/api',fastReplyTokens:1024}));
  for(const value of [1024,'512',0,null]) {
    mock.mock.mockImplementation(async()=>Response.json({space:null,apiBase:'/api',fastReplyTokens:value}));
    await assert.rejects(loadConfig(),/reply configuration/);
  }
});
test('a broken connection does not continue or falsely complete a partial answer',async t=>{
  let calls=0,text='';
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":"length"}]}\n\n')});
  await assert.rejects(reply({apiBase:'https://app.test/api',space:null},message,false,new AbortController().signal,value=>{text=value},()=>{}),/connection ended/);
  assert.equal(text,'Partial');assert.equal(calls,1);
});
test('Stop after a capped segment prevents any continuation request',async t=>{
  const controller=new AbortController();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return event('Partial','length')});
  await assert.rejects(reply({apiBase:'https://app.test/api',space:null},message,false,controller.signal,()=>{controller.abort()},()=>{}),{name:'AbortError'});
  assert.equal(calls,1);
});
test('a failure on a later segment leaves already streamed text available',async t=>{
  let calls=0,text='';
  t.mock.method(globalThis,'fetch',async()=>++calls===1?event('Beginning of answer ','length'):Response.json({error:'Busy'},{status:503}));
  await assert.rejects(reply({apiBase:'https://app.test/api',space:null},message,false,new AbortController().signal,value=>{text=value},()=>{}),/Busy/);
  assert.equal(text,'Beginning of answer ');
});
test('no-progress and runaway continuations are bounded',async t=>{
  let calls=0;
  const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;return event('','length')});
  await assert.rejects(reply({apiBase:'https://app.test/api',space:null},message,false,new AbortController().signal,()=>{},()=>{}),/before writing/);
  assert.equal(calls,1);
  calls=0;mock.mock.mockImplementation(async()=>{calls++;return event('More ','length')});
  await assert.rejects(reply({apiBase:'https://app.test/api',space:null},message,false,new AbortController().signal,()=>{},()=>{}),/conversation budget/);
  assert.equal(calls,16);
});
test('DONE without a model finish reason is not proof of a complete answer',async t=>{
  t.mock.method(globalThis,'fetch',async()=>event('Partial',null));
  await assert.rejects(reply({apiBase:'https://app.test/api',space:null},message,false,new AbortController().signal,()=>{},()=>{}),/did not confirm/);
});

const answerId='55555555-5555-4555-8555-555555555555',receipt='66666666-6666-4666-8666-666666666666';
const gated={apiBase:'https://app.test/api',space:null,accountControl:true,requireAuth:true};
function admittedEvent(text,reason,nextReceipt){
  return new Response(`data: ${JSON.stringify({answer:{id:answerId}})}\n\ndata: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:reason}]})}\n\n${nextReceipt?`data: ${JSON.stringify({answer:{id:answerId,receipt:nextReceipt}})}\n\n`:''}data: [DONE]\n\n`);
}
test('account-controlled continuations consume the issued receipt and preserve one answer identity',async t=>{
  location(t);const bodies=[];let text='';
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,gated.apiBase+'/chat');bodies.push(JSON.parse(options.body));
    return bodies.length===1?admittedEvent('First ','length',receipt):admittedEvent('second.','stop');
  });
  await reply(gated,message,true,new AbortController().signal,value=>{text=value},()=>{},'dummy-session');
  assert.equal(text,'First second.');assert.equal(bodies.length,2);assert.equal(bodies[0].answerId,undefined);
  assert.equal(bodies[1].answerId,answerId);assert.equal(bodies[1].receipt,receipt);assert.equal(bodies[1].mode,'fast');
});
test('Stop uses an independent authenticated metadata-only cancellation even between segments',async t=>{
  location(t);const controller=new AbortController(),calls=[];let responseReleased=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push([url,options]);
    if(url.endsWith('/answer/cancel')){
      assert.equal(options.signal.aborted,false);assert.equal(options.headers.Authorization,'Bearer dummy-session');assert.equal(options.keepalive,true);
      assert.deepEqual(JSON.parse(options.body),{answerId});return new Response(new ReadableStream({start(output){output.enqueue(new TextEncoder().encode('{"state":"finished"}'))},cancel(){responseReleased=true}}));
    }
    return admittedEvent('Partial','length',receipt);
  });
  await assert.rejects(reply(gated,message,false,controller.signal,()=>controller.abort(),()=>{},'dummy-session'),{name:'AbortError'});
  assert.deepEqual(calls.map(call=>call[0]),[gated.apiBase+'/chat',gated.apiBase+'/answer/cancel']);
  assert.equal(responseReleased,true);
});
test('a missing receipt or broken later stream preserves partial text and settles the known answer',async t=>{
  location(t);let chatCalls=0,cancels=0,text='';
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.endsWith('/answer/cancel')){cancels++;return Response.json({state:'finished'})}
    chatCalls++;return admittedEvent('Partial','length');
  });
  await assert.rejects(reply(gated,message,false,new AbortController().signal,value=>{text=value},()=>{},'dummy-session'),/continued safely/);
  assert.equal(text,'Partial');assert.equal(chatCalls,1);assert.equal(cancels,1);
});
test('account-controlled streams reject a changed answer identity and cannot send the session off-origin',async t=>{
  location(t);let cancels=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.endsWith('/answer/cancel')){cancels++;return Response.json({state:'finished'})}
    return new Response(`data: {"answer":{"id":"${answerId}"}}\n\ndata: {"answer":{"id":"${receipt}"}}\n\ndata: [DONE]\n\n`);
  });
  await assert.rejects(reply(gated,message,false,new AbortController().signal,()=>{},()=>{},'dummy-session'),/verified/);assert.equal(cancels,1);
  await assert.rejects(reply({...gated,apiBase:'https://foreign.test/api'},message,false,new AbortController().signal,()=>{},()=>{},'dummy-session'),/own API/);
});

test('long answers read the current session before each segment',async t=>{
  location(t);let token='old-token';const sent=[],updates=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    sent.push(options.headers.Authorization);
    if(sent.length===1){token='renewed-token';return event('First ','length')}
    return event('complete','stop');
  });
  await reply({...gated,accountControl:false},message,false,new AbortController().signal,v=>updates.push(v),()=>{},async()=>({accessToken:token,userId:'account-a'}));
  assert.deepEqual(sent,['Bearer old-token','Bearer renewed-token']);assert.equal(updates.at(-1),'First complete');
});
test('an explicit pre-admission JWT rejection refreshes and retries only the rejected segment once',async t=>{
  location(t);const sent=[],resolves=[];let token='initial';
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    sent.push({authorization:options.headers.Authorization,body:options.body});
    if(sent.length===1)return event('Kept ','length');
    if(sent.length===2)return Response.json({code:'session_required',error:'Sign in'},{status:401});
    return event('complete','stop');
  });
  let text='';await reply({...gated,accountControl:false},message,false,new AbortController().signal,v=>{text=v},()=>{},async refresh=>{
    resolves.push(refresh);if(refresh)token='new';return {accessToken:token,userId:'account-a'};
  });
  assert.deepEqual(resolves,[false,false,true]);assert.equal(sent.length,3);
  assert.equal(sent[1].body,sent[2].body);assert.equal(sent[2].authorization,'Bearer new');assert.equal(text,'Kept complete');
});
test('repeated JWT rejection and ambiguous service rejection never loop or replay generated text',async t=>{
  location(t);
  for(const explicit of [true,false]) {
    let calls=0,refreshes=0,text='';
    const mock=t.mock.method(globalThis,'fetch',async()=>{
      calls++;if(calls===1)return event('Partial ','length');
      return Response.json({error:'Rejected',...(explicit?{code:'session_required'}:{})},{status:401});
    });
    await assert.rejects(reply({...gated,accountControl:false},message,false,new AbortController().signal,v=>{text=v},()=>{},async refresh=>{
      if(refresh)refreshes++;return {accessToken:'fixture',userId:'account-a'};
    }),explicit?/session expired/:/Rejected/);
    assert.equal(calls,explicit?3:2);assert.equal(refreshes,explicit?1:0);assert.equal(text,'Partial ');mock.mock.restore();
  }
});
test('an account switch cannot receive a continuation or cancellation for the prior account',async t=>{
  location(t);let userId='account-a',calls=0,text='';
  t.mock.method(globalThis,'fetch',async()=>{calls++;userId='account-b';return admittedEvent('Kept ','length',receipt)});
  await assert.rejects(reply(gated,message,false,new AbortController().signal,v=>{text=v},()=>{},async()=>({accessToken:'fixture',userId})),/account changed/);
  assert.equal(calls,1);assert.equal(text,'Kept ');
});
test('Stop during a forced refresh prevents a delayed chat retry',async t=>{
  location(t);const controller=new AbortController();let calls=0,resolve;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({code:'session_required'},{status:401})});
  const pending=new Promise(r=>{resolve=r});
  const result=reply({...gated,accountControl:false},message,false,controller.signal,()=>{},()=>{},async refresh=>refresh?pending:{accessToken:'old',userId:'account-a'});
  await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(result,{name:'AbortError'});
  resolve({accessToken:'late',userId:'account-a'});await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});

test('Stop settles metadata with the current same-account token, not the initial token',async t=>{
  location(t);const controller=new AbortController();let token='before',chats=0,cancels=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.endsWith('/answer/cancel')) {
      cancels++;assert.equal(options.headers.Authorization,'Bearer after');assert.equal(options.signal.aborted,false);
      assert.deepEqual(JSON.parse(options.body),{answerId});return Response.json({state:'finished'});
    }
    chats++;assert.equal(options.headers.Authorization,'Bearer before');token='after';return admittedEvent('Kept','length',receipt);
  });
  await assert.rejects(reply(gated,message,false,controller.signal,()=>controller.abort(),()=>{},async()=>({accessToken:token,userId:'account-a'})),{name:'AbortError'});
  assert.equal(chats,1);assert.equal(cancels,1);
});
