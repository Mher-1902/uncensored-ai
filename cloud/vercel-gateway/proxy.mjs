import {AccountError} from './account-store.mjs';
const MAX_BODY = 65536;
export function json(status, value) {
  return Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff'}});
}

export function routeRequest(request, path, sameOrigin = true) {
  if (new URL(request.url).pathname !== path) return json(404, {error: 'API route not found.'});
  const method = ['/api/health', '/api/account'].includes(path) ? 'GET' : 'POST';
  if (request.method !== method) return json(405, {error: 'Method not allowed.'});
  if (sameOrigin && request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return json(403, {error: 'This website is not allowed to use this server.'});
  if (method === 'POST') {
    if (request.headers.get('x-offscript-client') !== 'web') return json(403, {error: 'Invalid client.'});
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return json(415, {error: 'Send JSON.'});
  }
}

async function bodyBytes(request, signal) {
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(Error('Invalid message data.'), {status: 400});
  const parts = []; let size = 0;
  const cancelled = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener('abort', cancelled, {once: true});
  try {
    if (signal.aborted) throw Error('Request cancelled.');
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (signal.aborted) throw Error('Request cancelled.');
      size += value.byteLength;
      if (size > MAX_BODY) throw Object.assign(Error('This message is too large. Please shorten it.'), {status: 413});
      parts.push(value);
    }
  } finally { signal.removeEventListener('abort', cancelled); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (signal.aborted) throw Error('Request cancelled.');
  const bytes = Buffer.concat(parts);
  try { JSON.parse(bytes.toString('utf8')); }
  catch { throw Object.assign(Error('Invalid message data.'), {status: 400}); }
  return bytes;
}

export async function bodyJSON(request, signal = request.signal) {
  return JSON.parse((await bodyBytes(request, signal)).toString('utf8'));
}

export async function forward(request, base, route, {headers = {}, fetchImpl = fetch, timeoutMs = 270000, sessionRejection = false} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, {once: true});
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const cleanup = () => {clearTimeout(timer); request.signal.removeEventListener('abort', abort);};
  try {
    const body = request.method === 'POST' ? await bodyBytes(request, controller.signal) : undefined;
    const upstream = await fetchImpl(new URL(route, base.endsWith('/') ? base : `${base}/`), {
      method: request.method, body, signal: controller.signal, redirect: 'error',
      headers: {...headers, ...(body ? {'Content-Type': 'application/json'} : {})},
    });
    if (!upstream.ok) {
      // Only recognized codes receive fixed public wording; never relay diagnostics.
      if(upstream.headers.get('content-type')?.split(';',1)[0]==='application/json') {
        try {
          const value=await bodyJSON(upstream,controller.signal);
          if(sessionRejection && upstream.status===401 && value?.code==='session_required') {
            cleanup();return json(401,{error:'Sign in before sending a message.',code:'session_required'});
          }
          if(upstream.status===503 && value?.code==='model_busy') {
            cleanup();return json(503,{error:'The model is busy. Please try again in a moment.',code:'model_busy'});
          }
          const safe=new AccountError(value?.code);
          if(value?.code===safe.code && upstream.status===safe.status) {cleanup();return json(safe.status,{error:safe.message,code:safe.code});}
        } catch { /* Untrusted upstream diagnostics remain redacted. */ }
      }
      await upstream.body?.cancel(); cleanup();
      const status = [400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(upstream.status) ? upstream.status : 502;
      return json(status, {ready: false, error: status === 401 ? 'Sign in before sending a message.' : 'The model could not complete this request. Please try again.'});
    }
    const type = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (!upstream.body || type !== (route.replace(/^\//, '') === 'api/chat' ? 'text/event-stream' : 'application/json')) {
      await upstream.body?.cancel(); cleanup();
      return json(502, {ready: false, error: 'The model sent an invalid response.'});
    }
    const reader = upstream.body.getReader();
    const stream = new ReadableStream({
      async pull(output) {
        try {
          const {done, value} = await reader.read();
          if (done) {cleanup(); output.close();}
          else output.enqueue(value);
        } catch {cleanup(); output.error(Error('The model connection ended before the response finished.'));}
      },
      async cancel(reason) {controller.abort(); cleanup(); await reader.cancel(reason).catch(() => {});},
    });
    return new Response(stream, {headers: {'Content-Type': upstream.headers.get('content-type'), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff'}});
  } catch (error) {
    controller.abort(); cleanup();
    return json(error.status || 503, {ready: false, error: error.status ? error.message : 'The model connection is unavailable. Please try again.'});
  }
}
