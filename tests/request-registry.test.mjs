import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestRegistry} from '../server/request-registry.mjs';

const requestId='11111111-1111-4111-8111-111111111111';
const workerId='22222222-2222-4222-8222-222222222222';
const otherWorker='33333333-3333-4333-8333-333333333333';

test('cancellation acknowledges only the matching worker request after cleanup',async()=>{
  const registry=createRequestRegistry({workerId});
  const record=registry.register(requestId,workerId,String(Date.now()+10000));
  let acknowledged=false;
  const cancel=registry.cancel({requestId,workerId}).then(value=>{acknowledged=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(record.controller.signal.aborted,true);assert.equal(acknowledged,false);
  record.finish(true,'cancelled');
  assert.deepEqual(await cancel,{requestId,workerId,workerStopped:true,outcome:'cancelled'});
  assert.deepEqual(await registry.cancel({requestId,workerId}),await cancel);
  assert.throws(()=>registry.register(requestId,workerId,String(Date.now()+10000)),/already received/);
});

test('unknown requests, process restarts and timed-out cleanup cannot release capacity',async()=>{
  const registry=createRequestRegistry({workerId});
  const record=registry.register(requestId,workerId,String(Date.now()+10000));
  assert.equal((await registry.cancel({requestId,workerId:otherWorker})).workerStopped,false);
  assert.equal(record.controller.signal.aborted,false);
  assert.equal((await createRequestRegistry({workerId:otherWorker}).cancel({requestId,workerId})).workerStopped,false);
  assert.equal((await registry.cancel({requestId,workerId},5)).workerStopped,false);
  record.finish(false,'cancelled');
  assert.equal((await registry.cancel({requestId,workerId})).workerStopped,false);
});

test('bounded receipts expire without permitting a delayed replay to start',async()=>{
  let clock=Date.now();
  const registry=createRequestRegistry({workerId,now:()=>clock,limit:1});
  const deadline=String(clock+1000);
  const record=registry.register(requestId,workerId,deadline);
  assert.throws(()=>registry.register(otherWorker,workerId,deadline),/busy/);
  assert.throws(()=>registry.register(otherWorker,otherWorker,deadline),/expired/);
  clock+=1001;
  // Active records cannot be evicted merely because their deadline passed.
  assert.throws(()=>registry.register(otherWorker,workerId,String(clock+1000)),/busy/);
  record.finish(true,'cancelled');
  registry.register(otherWorker,workerId,String(clock+1000)).finish(true,'rejected');
  assert.throws(()=>registry.register(requestId,workerId,deadline),/expired/);
  assert.throws(()=>registry.register(requestId,workerId,String(clock+300001)),/expired/);
});
test('Stop before dispatch permanently aborts the prepared claim without claiming unknown work stopped',async()=>{
  const registry=createRequestRegistry({workerId}),deadline=String(Date.now()+10000);
  assert.deepEqual(registry.prepare({requestId,workerId,deadline}),{prepared:true,requestId,workerId});
  assert.deepEqual(await registry.cancel({requestId,workerId}),{requestId,workerId,workerStopped:true,outcome:'rejected'});
  const claimed=registry.claim(requestId,workerId,deadline);assert.equal(claimed.controller.signal.aborted,true);
  assert.throws(()=>registry.claim(requestId,workerId,deadline),/unavailable/);
  assert.equal((await registry.cancel({requestId:otherWorker,workerId})).workerStopped,false);
});
test('undispatched rejected admissions can discard preparation; active work cannot be discarded',async()=>{
  const registry=createRequestRegistry({workerId,limit:1}),deadline=String(Date.now()+10000);
  registry.prepare({requestId,workerId,deadline});await registry.cancel({requestId,workerId,discard:true});
  registry.prepare({requestId:otherWorker,workerId,deadline});const active=registry.claim(otherWorker,workerId,deadline);
  const cancellation=registry.cancel({requestId:otherWorker,workerId,discard:true},5);assert.equal((await cancellation).workerStopped,false);
  assert.throws(()=>registry.prepare({requestId,workerId,deadline}),/busy/);active.finish(true,'cancelled');
});
test('unclaimed preparations expire safely while claimed computation remains retained',()=>{
  let clock=Date.now();const registry=createRequestRegistry({workerId,now:()=>clock,limit:1});
  const deadline=String(clock+1000);registry.prepare({requestId,workerId,deadline});clock+=1001;
  registry.prepare({requestId:otherWorker,workerId,deadline:String(clock+1000)});
  assert.throws(()=>registry.claim(requestId,workerId,deadline),/unavailable/);
});
