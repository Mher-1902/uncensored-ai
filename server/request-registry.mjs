import {randomUUID} from 'node:crypto';
import {RequestError} from './request.mjs';

export const isRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// Bounded, content-free receipts belong to this worker process only. An unknown
// request or a restarted process never constitutes proof that old work stopped.
export function createRequestRegistry({now = Date.now, limit = 1024, workerId = randomUUID()} = {}) {
  const records = new Map();
  function register(requestId, expectedWorker, deadline) {
    const expiresAt = Number(deadline);
    if (!isRequestId(requestId) || !isRequestId(expectedWorker) || !/^\d{13}$/.test(String(deadline))) throw new RequestError(400,'Invalid request receipt.');
    if (expectedWorker !== workerId || expiresAt <= now() || expiresAt > now() + 300000) throw new RequestError(409,'The request receipt has expired.');
    for (const [id, record] of records) {
      if(record.prepared && !record.claimed && record.expiresAt<=now()) {record.controller.abort();record.finish(true,'rejected');}
      if(record.settled && record.expiresAt<=now())records.delete(id);
    }
    if (records.has(requestId)) throw new RequestError(409,'This request was already received.');
    if (records.size >= limit) throw new RequestError(503,'The server is busy. Please try again shortly.');
    let resolve;
    const record = {requestId, workerId, expiresAt, controller:new AbortController(), settled:false, done:new Promise(done => {resolve=done;})};
    record.finish = (workerStopped, outcome) => {
      if (record.settled) return;
      record.settled=true;
      record.proof={requestId,workerId,workerStopped,outcome};
      resolve(record.proof);
    };
    records.set(requestId,record);
    return record;
  }
  function prepare(value) {
    if(!value || Array.isArray(value) || Object.keys(value).sort().join(',')!=='deadline,requestId,workerId')throw new RequestError(400,'Invalid request receipt.');
    const record=register(value.requestId,value.workerId,value.deadline);
    record.prepared=true;record.claimed=false;
    return {prepared:true,requestId:record.requestId,workerId};
  }
  function claim(requestId,expectedWorker,deadline) {
    const record=expectedWorker===workerId?records.get(requestId):undefined;
    if(!record || !record.prepared || record.claimed || String(record.expiresAt)!==String(deadline) || record.expiresAt<=now())throw new RequestError(409,'The prepared request is unavailable.');
    record.claimed=true;
    // A pre-dispatch cancellation leaves this controller aborted. The handler
    // can return matching cleanup proof but can never start model computation.
    return record;
  }
  async function cancel(value, waitMs = 20000) {
    if (!value || Array.isArray(value) || !['requestId,workerId','discard,requestId,workerId'].includes(Object.keys(value).sort().join(','))
      || value.discard!==undefined&&typeof value.discard!=='boolean'
      || !isRequestId(value.requestId) || !isRequestId(value.workerId)) throw new RequestError(400,'Invalid request receipt.');
    const record = value.workerId === workerId ? records.get(value.requestId) : undefined;
    if (!record) return {requestId:value.requestId,workerId,workerStopped:false};
    record.controller.abort();
    if(record.prepared && !record.claimed){
      record.finish(true,'rejected');
      // Used only when the trusted bridge knows it sent no dispatch. Failed
      // database admissions cannot fill the registry with five-minute receipts.
      if(value.discard===true)records.delete(value.requestId);
    }
    let timer;
    try {
      return await Promise.race([record.done,new Promise(resolve => {timer=setTimeout(() => resolve({requestId:record.requestId,workerId,workerStopped:false}),waitMs);})]);
    } finally {clearTimeout(timer);}
  }
  return {workerId,register,prepare,claim,cancel};
}
