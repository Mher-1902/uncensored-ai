import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyStream} from '../src/integrity.ts';
const sha=data=>createHash('sha256').update(data).digest('hex');
const data=Uint8Array.from({length:35},(_,i)=>i);
const manifest={bytes:data.length,chunkBytes:8,chunks:Array.from({length:5},(_,i)=>sha(data.slice(i*8,(i+1)*8)))};
const stream=(pieces)=>new ReadableStream({start(c){for(const piece of pieces)c.enqueue(piece);c.close();}});
test('bounded verification handles network chunks across manifest boundaries, in order',async()=>{
  const chunks=[],progress=[];
  assert.equal(await verifyStream(stream([data.slice(0,3),data.slice(3,20),data.slice(20)]),manifest,{
    onChunk:async b=>chunks.push(b.slice()),onProgress:n=>progress.push(n)}),35);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(data));assert.deepEqual(progress,[8,16,24,32,35]);
});
test('changed bytes, reordering, missing and surplus data never finish verification',async()=>{
  const changed=data.slice();changed[20]^=1;
  const reordered=Uint8Array.from([...data.slice(8,16),...data.slice(0,8),...data.slice(16)]);
  for(const b of [changed,reordered,data.slice(0,-1),Uint8Array.from([...data,0])])await assert.rejects(verifyStream(stream([b]),manifest));
});
test('Stop cancels a stalled download and also prevents late verified writes',async()=>{
  const controller=new AbortController();let cancelled=false;
  const pending=verifyStream(new ReadableStream({cancel(){cancelled=true;}}),manifest,{signal:controller.signal});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,true);
  const next=new AbortController();let written=false;
  await assert.rejects(verifyStream(stream([data]),manifest,{signal:next.signal,
    digest:async b=>{next.abort();return sha(b)},onChunk:async()=>{written=true}}),{name:'AbortError'});
  assert.equal(written,false);
});
