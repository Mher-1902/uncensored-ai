import {forward, json, routeRequest} from '../cloud/vercel-gateway/proxy.mjs';

// Bindings exist in functions at runtime, never in the Vite build or browser.
export function createAppHandler(path, {env = process.env, fetchImpl = fetch} = {}) {
  return async request => {
    const rejected = routeRequest(request, path);
    if (rejected) return rejected;
    if (!env.GATEWAY_URL) return json(503, {ready: false, error: 'The model connection is not configured.'});
    const headers = {'X-Offscript-Client': 'web'};
    const authorization = request.headers.get('authorization');
    if (authorization) headers.Authorization = authorization;
    return forward(request, env.GATEWAY_URL, path.slice(1), {headers, fetchImpl, timeoutMs: 280000});
  };
}
