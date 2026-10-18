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
  const raw=await bodyJSON(request),input=validateRequest(raw);
  if(input.continuation ? !isRequestId(raw.answerId)||!isRequestId(raw.receipt) : raw.answerId!==undefined||raw.receipt!==undefined) {
    throw Object.assign(Error('Invalid answer continuation.'),{status:400});
  }
  const credentials = {Authorization:`Bearer ${credential}`,'X-Offscript-Client':'web'};
  const preflight = await fetchImpl(new URL('/api/health',origin), {
    headers:credentials,redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(5000)]),
  });
  if (!preflight.ok || preflight.headers.get('content-type')?.split(';',1)[0] !== 'application/json') {
    await preflight.body?.cancel();throw new AccountError();
  }
  const health = await bodyJSON(preflight,AbortSignal.any([request.signal,AbortSignal.timeout(5000)]));
  if (health.protocol !== 5 || health.ready !== true || !isRequestId(health.workerId)) throw new AccountError();
  const id=randomUUID(),answerId=input.continuation?raw.answerId:randomUUID(),workerId=health.workerId,deadline=Date.now()+260000;
  const controller=new AbortController();
  let settlement,recovery,iterator,forwarded=false,preparationAttempted=false,reservationAttempted=false,admitted=false;
  let stopped=false,outcome='failed',promptTokens=null,completionTokens=null,finishReason=null,visible=false,finished=false;
  let resolveLifetime;
  // Register before the database write: disconnects can race admission itself.
  // A cancelled Vercel invocation survives only while waitUntil keeps it alive.
  defer(new Promise(resolve=>{resolveLifetime=resolve;}));
  function cleanup() {
    if(finished)return;
    finished=true;clearTimeout(timer);request.signal.removeEventListener('abort',abort);resolveLifetime();
  }
  function settle(result,confirmed) {
    return settlement ||= store.finishSegment(user,answerId,id,workerId,result,promptTokens,completionTokens,finishReason,visible,confirmed);
  }
  function proof(event) {
    const control=event?.control;
    if (control?.requestId===id && control.workerId===workerId && control.workerStopped===true
      && ['completed','failed','rejected','cancelled'].includes(control.outcome)) {
      stopped=true;outcome=control.outcome;
    }
    const usage=event?.usage;
    if(usage!==undefined) {
      const limit=input.maxTokens+(input.mode==='deep'?256:0);
      if (Number.isInteger(usage?.prompt_tokens) && Number.isInteger(usage?.completion_tokens)
        && usage.prompt_tokens>=0 && usage.completion_tokens>=0 && usage.completion_tokens<=limit && usage.prompt_tokens+usage.completion_tokens<=4096) {
        promptTokens=usage.prompt_tokens;completionTokens=usage.completion_tokens;
      } else {promptTokens=null;completionTokens=null;}
    }
    const choice=event?.choices?.[0];
    if(typeof choice?.delta?.content==='string' && choice.delta.content.length)visible=true;
    if(choice?.finish_reason) {
      if(!['stop','length'].includes(choice.finish_reason) || finishReason && finishReason!==choice.finish_reason)throw new AccountError();
      finishReason=choice.finish_reason;
    }
  }
  function recover(reason='failed') {
    return recovery ||= (async()=>{
      controller.abort();
      // The database mark also prevents a continuation that races Stop after
      // the previous worker has already settled into its waiting handoff.
      if(admitted)try {await store.cancelAnswer(user,answerId);} catch { /* Fail closed if the write is unavailable. */ }
      if(!forwarded){stopped=true;outcome='rejected';}
      if((!forwarded && preparationAttempted) || forwarded && !stopped && !settlement) {
        try {
          // Independent of the disconnected browser's abort signal.
          const signal=AbortSignal.timeout(23000);
          const response=await fetchImpl(new URL('/api/cancel',origin),{method:'POST',redirect:'error',signal,
            headers:{...credentials,'Content-Type':'application/json'},body:JSON.stringify({requestId:id,workerId,...(!forwarded?{discard:true}:{})})});
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
    // Register a cancellable identity before committing database admission.
    // Stop can then prevent even a dispatch that has not reached the worker yet.
    preparationAttempted=true;
    const preparing=AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]);
    const preparation=await fetchImpl(new URL('/api/prepare',origin),{method:'POST',redirect:'error',signal:preparing,
      headers:{...credentials,'Content-Type':'application/json'},body:JSON.stringify({requestId:id,workerId,deadline:String(deadline)})});
    if(!preparation.ok || preparation.headers.get('content-type')?.split(';',1)[0]!=='application/json'){await preparation.body?.cancel();throw new AccountError();}
    const prepared=await bodyJSON(preparation,preparing);
    if(prepared.prepared!==true || prepared.requestId!==id || prepared.workerId!==workerId)throw new AccountError();
    if(controller.signal.aborted)throw new AccountError();
    reservationAttempted=true;
    const reservation=input.continuation
      ? await store.continueAnswer(user,answerId,raw.receipt,id,workerId,input.maxTokens)
      : await store.startAnswer(user,answerId,id,workerId,input.mode,input.maxTokens);
    if(reservation.state!=='active')throw new AccountError('continuation_invalid');
    if(reservation.answerId!==answerId || reservation.requestId!==id || !Number.isInteger(reservation.maxTokens)
      || reservation.maxTokens<1 || reservation.maxTokens>input.maxTokens)throw new AccountError();
    admitted=true;input.maxTokens=reservation.maxTokens;
    if(controller.signal.aborted)throw new AccountError();
    forwarded=true;
    const upstream=await fetchImpl(new URL('/api/chat',origin),{method:'POST',redirect:'error',signal:controller.signal,
      headers:{...credentials,'Content-Type':'application/json','X-Offscript-Request-ID':id,'X-Offscript-Worker-ID':workerId,'X-Offscript-Request-Deadline':String(deadline),'X-Offscript-Prepared':'true'},body:JSON.stringify(input)});
    if(upstream.headers.get('x-offscript-protocol')!=='5') {
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
      start(output) {output.enqueue(encoder.encode(`data: ${JSON.stringify({answer:{id:answerId}})}\n\n`));},
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
              if(controller.signal.aborted)throw new AccountError();
              if(result.state==='waiting') {
                if(finishReason!=='length' || result.answerId!==answerId || !isRequestId(result.receipt))throw new AccountError();
                output.enqueue(encoder.encode(`data: ${JSON.stringify({answer:{id:answerId,receipt:result.receipt}})}\n\n`));
              } else if(result.state!=='finished' || result.outcome!=='completed' || finishReason!=='stop') {
                cleanup();await iterator.return?.();
                output.enqueue(encoder.encode('data: {"error":"The answer could not finish within the available conversation budget. The text received so far is kept."}\n\n'));output.close();return;
              }
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

// A separate authenticated request covers Stop between completed segments.
// It never sends account sessions or database identifiers to the native model.
export async function cancelAdmittedAnswer(request,{user,store,origin,credential,fetchImpl=fetch,defer=waitUntil}) {
  const body=await bodyJSON(request);
  if(!body || Object.keys(body).join(',')!=='answerId' || !isRequestId(body.answerId))return json(400,{error:'Invalid answer cancellation.'});
  const task=(async()=>{
    const target=await store.cancelAnswer(user,body.answerId);
    if(target.state==='finished')return json(200,{state:'finished'});
    if(!['active','uncertain'].includes(target.state) || !isRequestId(target.requestId) || !isRequestId(target.workerId))throw new AccountError();
    let stopped=false,outcome='cancelled';
    try {
      const signal=AbortSignal.timeout(23000);
      const response=await fetchImpl(new URL('/api/cancel',origin),{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${credential}`,'X-Offscript-Client':'web','Content-Type':'application/json'},
        body:JSON.stringify({requestId:target.requestId,workerId:target.workerId})});
      if(response.ok && response.headers.get('content-type')?.split(';',1)[0]==='application/json') {
        const {control}=await bodyJSON(response,signal);
        stopped=control?.requestId===target.requestId && control.workerId===target.workerId && control.workerStopped===true
          && ['completed','cancelled','rejected','failed'].includes(control.outcome);
        if(stopped&&control.outcome==='rejected')outcome='rejected';
      } else await response.body?.cancel();
    } catch { /* Unknown model state continues to occupy capacity. */ }
    const result=await store.finishSegment(user,body.answerId,target.requestId,target.workerId,outcome,null,null,null,false,stopped);
    if(!['finished','uncertain'].includes(result.state))throw new AccountError();
    return json(200,{state:result.state});
  })();
  defer(task.catch(()=>{}));
  return task;
}
