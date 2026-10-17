import {randomUUID} from 'node:crypto';
import {waitUntil} from '@vercel/functions';
import {readEvents} from '../../src/stream.ts';
import {validateRequest} from '../../server/request.mjs';
import {isRequestId} from '../../server/request-registry.mjs';
import {AccountError} from './account-store.mjs';
import {bodyJSON,json} from './proxy.mjs';

const workerFailure = status => json([400,401,403,413,415,422,429,503].includes(status) ? status : 502,
  {error: status === 422 ? 'This conversation has filled the model context. Start a new chat for another question.' : 'The model could not complete this request. Please try again.'});

export async function admittedChat(request, {user,store,origin,credential,fetchImpl=fetch,defer=waitUntil}) {
  const input = validateRequest(await bodyJSON(request));
  const credentials = {Authorization:`Bearer ${credential}`,'X-Offscript-Client':'web'};
  const preflight = await fetchImpl(new URL('/api/health',origin), {
    headers:credentials,redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(5000)]),
  });
  if (!preflight.ok || preflight.headers.get('content-type')?.split(';',1)[0] !== 'application/json') {
    await preflight.body?.cancel();throw new AccountError();
  }
  const health = await bodyJSON(preflight,AbortSignal.any([request.signal,AbortSignal.timeout(5000)]));
  if (health.protocol !== 4 || health.ready !== true || !isRequestId(health.workerId)) throw new AccountError();
  const id=randomUUID(),workerId=health.workerId,deadline=Date.now()+260000;
  const controller=new AbortController();
  let settlement,recovery,iterator,forwarded=false,reservationAttempted=false,admitted=false;
  let stopped=false,outcome='failed',promptTokens=null,completionTokens=null,finished=false;
  let resolveLifetime;
  // Register before the database write: disconnects can race admission itself.
  // A cancelled Vercel invocation survives only while waitUntil keeps it alive.
  defer(new Promise(resolve=>{resolveLifetime=resolve;}));
  function cleanup() {
    if(finished)return;
    finished=true;clearTimeout(timer);request.signal.removeEventListener('abort',abort);resolveLifetime();
  }
  function settle(result,confirmed) {
    return settlement ||= store.finish(user,id,result,promptTokens,completionTokens,confirmed);
  }
  function proof(event) {
    const control=event?.control;
    if (control?.requestId===id && control.workerId===workerId && control.workerStopped===true
      && ['completed','failed','rejected','cancelled'].includes(control.outcome)) {
      stopped=true;outcome=control.outcome;
    }
    const usage=event?.usage;
    if (Number.isInteger(usage?.prompt_tokens) && Number.isInteger(usage?.completion_tokens)
      && usage.prompt_tokens>=0 && usage.completion_tokens>=0 && usage.prompt_tokens+usage.completion_tokens<=4096) {
      promptTokens=usage.prompt_tokens;completionTokens=usage.completion_tokens;
    }
  }
  function recover(reason='failed') {
    return recovery ||= (async()=>{
      controller.abort();
      if(!forwarded){stopped=true;outcome='rejected';}
      else if(!stopped && !settlement) {
        try {
          // Independent of the disconnected browser's abort signal.
          const signal=AbortSignal.timeout(23000);
          const response=await fetchImpl(new URL('/api/cancel',origin),{method:'POST',redirect:'error',signal,
            headers:{...credentials,'Content-Type':'application/json'},body:JSON.stringify({requestId:id,workerId})});
          if(response.ok && response.headers.get('content-type')?.split(';',1)[0]==='application/json')proof(await bodyJSON(response,signal));
          else await response.body?.cancel();
        } catch { /* Unknown receipts retain capacity; expiry never releases it. */ }
      }
      try {if(reservationAttempted)await settle(stopped?outcome:reason,stopped);} catch { /* Operator recovery is still required if the database is unavailable. */ }
      finally {
        cleanup();
        void iterator?.return?.().catch(()=>{});
      }
    })();
  }
  const abort=()=>{controller.abort();if(admitted)void recover('cancelled');};
  request.signal.addEventListener('abort',abort,{once:true});
  if(request.signal.aborted)abort();
  const timer=setTimeout(abort,Math.max(0,deadline-Date.now()));
  try {
    if(controller.signal.aborted)throw new AccountError();
    reservationAttempted=true;
    await store.reserve(user,id,input.mode,input.maxTokens);admitted=true;
    if(controller.signal.aborted)throw new AccountError();
    forwarded=true;
    const upstream=await fetchImpl(new URL('/api/chat',origin),{method:'POST',redirect:'error',signal:controller.signal,
      headers:{...credentials,'Content-Type':'application/json','X-Offscript-Request-ID':id,'X-Offscript-Worker-ID':workerId,'X-Offscript-Request-Deadline':String(deadline)},body:JSON.stringify(input)});
    if(upstream.headers.get('x-offscript-protocol')!=='4') {
      await upstream.body?.cancel();throw new AccountError();
    }
    if(!upstream.ok) {
      if(upstream.headers.get('content-type')?.split(';',1)[0]==='application/json')proof(await bodyJSON(upstream,controller.signal));
      else await upstream.body?.cancel();
      await recover();
      return workerFailure(upstream.status);
    }
    if(!upstream.body || upstream.headers.get('content-type')?.split(';',1)[0]!=='text/event-stream') {
      await upstream.body?.cancel();throw new AccountError();
    }
    iterator=readEvents(upstream.body)[Symbol.asyncIterator]();
    const encoder=new TextEncoder();let total=0;
    const stream=new ReadableStream({
      async pull(output) {
        try {
          for(;;) {
            const next=await iterator.next();
            if(next.done)throw new AccountError();
            total+=next.value.length;
            if(total>2097152)throw new AccountError();
            if(next.value==='[DONE]') {
              if(!stopped || outcome!=='completed')throw new AccountError();
              const result=await settle('completed',true);
              if(result.state!=='finished')throw new AccountError();
              cleanup();await iterator.return?.();
              output.enqueue(encoder.encode('data: [DONE]\n\n'));output.close();return;
            }
            const event=JSON.parse(next.value);proof(event);
            if(event.error) {
              await recover();
              output.enqueue(encoder.encode('data: {"error":"The model could not complete this request. Please try again."}\n\n'));output.close();return;
            }
            if(event.choices || event.usage) {
              output.enqueue(encoder.encode(`data: ${JSON.stringify({choices:event.choices,usage:event.usage})}\n\n`));return;
            }
          }
        } catch {
          await recover();
          output.error(Error('The reply could not be finalized. Please try again.'));
        }
      },
      async cancel() {await recover('cancelled');},
    });
    return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'}});
  } catch(error) {
    await recover();
    if(!admitted && error instanceof AccountError)throw error;
    throw new AccountError();
  }
}
