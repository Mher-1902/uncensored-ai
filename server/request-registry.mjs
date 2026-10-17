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
    for (const [id, record] of records) if (record.settled && record.expiresAt <= now()) records.delete(id);
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
  async function cancel(value, waitMs = 20000) {
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'requestId,workerId'
      || !isRequestId(value.requestId) || !isRequestId(value.workerId)) throw new RequestError(400,'Invalid request receipt.');
    const record = value.workerId === workerId ? records.get(value.requestId) : undefined;
    if (!record) return {requestId:value.requestId,workerId,workerStopped:false};
    record.controller.abort();
    let timer;
    try {
      return await Promise.race([record.done,new Promise(resolve => {timer=setTimeout(() => resolve({requestId:record.requestId,workerId,workerStopped:false}),waitMs);})]);
    } finally {clearTimeout(timer);}
  }
  return {workerId,register,cancel};
}
