import {createVerifier} from './auth.mjs';
import {Hono} from 'hono';
import {forward, json, routeRequest, bodyJSON} from './proxy.mjs';
import {accountControlEnabled,accountFailure,createAccountStore} from './account-store.mjs';
import {admittedChat} from './admission.mjs';

export function createBridge({env = process.env, fetchImpl = fetch, verify, accountStore} = {}) {
  let verifier, configuredFor;
  const store=accountStore || createAccountStore({env});
  return async request => {
    const path = new URL(request.url).pathname;
    if (!['/api/health', '/api/chat', '/api/account', '/api/acceptance'].includes(path)) return json(404, {error: 'API route not found.'});
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
    let user;
    if (path !== '/api/health') {
      try { user=await verifier(request.headers.get('authorization')); }
      catch { return json(401, {error: 'Sign in before sending a message.'}); }
    }
    try {
      const enabled=accountControlEnabled(env);
      if(path==='/api/account' || path==='/api/acceptance') {
        if(!enabled)return json(404,{error:'Account controls are not active.'});
        if(path==='/api/account')return json(200,await store.account(user));
        const data=await bodyJSON(request);
        if(!data || Array.isArray(data) || Object.keys(data).sort().join(',')!=='accepted,privacyVersion,termsVersion' || data.accepted!==true
          || ![data.termsVersion,data.privacyVersion].every(value=>typeof value==='string' && /^[A-Za-z0-9._-]{1,64}$/.test(value)))return json(400,{error:'Confirm the current policy versions.'});
        return json(200,await store.accept(user,data.termsVersion,data.privacyVersion));
      }
      if(enabled && path==='/api/chat')return await admittedChat(request,{user,store,origin:env.SAMSUNG_API_ORIGIN,credential:samsungToken,fetchImpl});
    } catch(error) {
      if([400,413,415].includes(error.status))return json(error.status,{error:error.message});
      const safe=accountFailure(error);return json(safe.status,{error:safe.message,code:safe.code});
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
