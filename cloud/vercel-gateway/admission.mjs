import {randomUUID} from 'node:crypto';
import {readEvents} from '../../src/stream.ts';
import {validateRequest} from '../../server/request.mjs';
import {AccountError} from './account-store.mjs';
import {bodyJSON,json} from './proxy.mjs';

const workerFailure = status => json([400,401,403,413,415,422,429,503].includes(status) ? status : 502,
  {error: status === 422 ? 'This conversation exceeds the model context. Shorten the reply or clear the chat.' : 'The model could not complete this request. Please try again.'});

// Only protocol 3 confirms cleanup on both success and controlled failure.
// A lost connection never implies that a GPU/CPU worker has stopped.
export async function admittedChat(request, {user,store,origin,credential,fetchImpl=fetch}) {
  const input = validateRequest(await bodyJSON(request));
  const credentials = {Authorization:`Bearer ${credential}`,'X-Offscript-Client':'web'};
  const preflight = await fetchImpl(new URL('/api/health',origin), {
    headers:credentials,redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(5000)]),
  });
  if (!preflight.ok || preflight.headers.get('content-type')?.split(';',1)[0] !== 'application/json') {
    await preflight.body?.cancel();throw new AccountError();
  }
  const health = await bodyJSON(preflight,AbortSignal.any([request.signal,AbortSignal.timeout(5000)]));
  if (health.protocol !== 3 || health.ready !== true) throw new AccountError();
  const id=randomUUID();
  await store.reserve(user,id,input.mode,input.maxTokens);
  const controller=new AbortController();
  const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});
  if(request.signal.aborted)abort();
  const timer=setTimeout(abort,260000);
  const cleanup=()=>{clearTimeout(timer);request.signal.removeEventListener('abort',abort);};
  let settlement,stopped=false,outcome='failed',promptTokens=null,completionTokens=null;
  function settle(result,confirmed) {
    return settlement ||= store.finish(user,id,result,promptTokens,completionTokens,confirmed);
  }
  function proof(event) {
    if (event?.control?.workerStopped===true && ['completed','failed','rejected'].includes(event.control.outcome)) {
      stopped=true;outcome=event.control.outcome;
    }
    const usage=event?.usage;
    if (Number.isInteger(usage?.prompt_tokens) && Number.isInteger(usage?.completion_tokens)
      && usage.prompt_tokens>=0 && usage.completion_tokens>=0 && usage.prompt_tokens+usage.completion_tokens<=4096) {
      promptTokens=usage.prompt_tokens;completionTokens=usage.completion_tokens;
    }
  }
  try {
    const upstream=await fetchImpl(new URL('/api/chat',origin),{method:'POST',redirect:'error',signal:controller.signal,
      headers:{...credentials,'Content-Type':'application/json'},body:JSON.stringify(input)});
    if(upstream.headers.get('x-offscript-protocol')!=='3') {
      await upstream.body?.cancel();throw new AccountError();
    }
    if(!upstream.ok) {
      if(upstream.headers.get('content-type')?.split(';',1)[0]==='application/json')proof(await bodyJSON(upstream,controller.signal));
      else await upstream.body?.cancel();
      await settle(stopped?outcome:'failed',stopped);cleanup();
      return workerFailure(upstream.status);
    }
    if(!upstream.body || upstream.headers.get('content-type')?.split(';',1)[0]!=='text/event-stream') {
      await upstream.body?.cancel();throw new AccountError();
    }
    const iterator=readEvents(upstream.body)[Symbol.asyncIterator]();
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
              await settle(stopped?outcome:'failed',stopped);cleanup();await iterator.return?.();
              output.enqueue(encoder.encode('data: {"error":"The model could not complete this request. Please try again."}\n\n'));output.close();return;
            }
            // Worker control acknowledgements are internal, never browser API data.
            if(event.choices || event.usage) {
              output.enqueue(encoder.encode(`data: ${JSON.stringify({choices:event.choices,usage:event.usage})}\n\n`));return;
            }
          }
        } catch {
          controller.abort();cleanup();await iterator.return?.().catch(()=>{});
          await settle('failed',stopped).catch(()=>{});
          output.error(Error('The reply could not be finalized. Please try again.'));
        }
      },
      async cancel() {
        controller.abort();cleanup();await iterator.return?.().catch(()=>{});
        await settle('cancelled',stopped).catch(()=>{});
      },
    });
    return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'}});
  } catch {
    controller.abort();cleanup();await settle('failed',stopped).catch(()=>{});throw new AccountError();
  }
}
