import test from 'node:test';
import assert from 'node:assert/strict';
import {reply} from '../src/api.ts';

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
  await assert.rejects(reply({apiBase:'/api',space:null,requireAuth:true},message,false,new AbortController().signal,()=>{},()=>{}),/Sign in/);
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
