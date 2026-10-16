import {createVerifier} from './auth.mjs';
import {Hono} from 'hono';
import {forward, json, routeRequest} from './proxy.mjs';

export function createBridge({env = process.env, fetchImpl = fetch, verify} = {}) {
  let verifier, configuredFor;
  return async request => {
    const path = new URL(request.url).pathname;
    if (!['/api/health', '/api/chat'].includes(path)) return json(404, {error: 'API route not found.'});
    const rejected = routeRequest(request, path, false);
    if (rejected) return rejected;
    // Clipboard-based environment setup can include surrounding whitespace.
    const samsungToken = typeof env.SAMSUNG_GATEWAY_TOKEN === 'string' ? env.SAMSUNG_GATEWAY_TOKEN.trim() : '';
    try {
      if (!env.SAMSUNG_API_ORIGIN || !samsungToken || !env.SUPABASE_URL) throw Error('Incomplete configuration.');
      const url = new URL(env.SAMSUNG_API_ORIGIN);
      if (url.protocol !== 'https:' || url.origin !== env.SAMSUNG_API_ORIGIN || !/^[\w-]{32,256}$/.test(samsungToken)) throw Error('Invalid configuration.');
      if (configuredFor !== env.SUPABASE_URL) {
        verifier = verify || createVerifier(env.SUPABASE_URL);
        configuredFor = env.SUPABASE_URL;
      }
    } catch {
      return json(503, {ready: false, error: 'The model connection is not configured.'});
    }
    if (path === '/api/chat') {
      try { await verifier(request.headers.get('authorization')); }
      catch { return json(401, {error: 'Sign in before sending a message.'}); }
    }
    // User JWTs stay at this boundary. The Samsung receives only its service credential.
    return forward(request, `${env.SAMSUNG_API_ORIGIN}/`, path.slice(1), {
      fetchImpl, timeoutMs: path === '/api/health' ? 5000 : 270000,
      headers: {'X-Offscript-Client': 'web', Authorization: `Bearer ${samsungToken}`},
    });
  };
}

const handler = createBridge();
const app = new Hono();
app.all('*', context => handler(context.req.raw));
export default app;
