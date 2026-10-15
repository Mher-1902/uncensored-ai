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
    assert.deepEqual(JSON.parse(options.body),{messages:[{role:'user',content:'Hello'}],maxTokens:256,reasoned:false});
    return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
  });
  await reply({apiBase:'https://app.test/api',space:null,requireAuth:true},message,256,false,new AbortController().signal,value=>{text=value},()=>{},'dummy-session');
  assert.equal(text,'Hello');assert.equal(calls,1);
});
test('missing sign-in leaves authenticated chat unsent',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('No request expected.');});
  await assert.rejects(reply({apiBase:'/api',space:null,requireAuth:true},message,256,false,new AbortController().signal,()=>{},()=>{}),/Sign in/);
  assert.equal(calls,0);
});
test('an account session is never sent to a separately configured model origin',async t=>{
  location(t);let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('No request expected.');});
  await assert.rejects(reply({apiBase:'https://model.test/api',space:null,requireAuth:true},message,256,false,new AbortController().signal,()=>{},()=>{},'dummy-session'),/own API/);
  assert.equal(calls,0);
});
