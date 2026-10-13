import metadata from '../public/config.json' with {type: 'json'};
import {json} from '../cloud/vercel-gateway/proxy.mjs';

// Also overrides Vite's public/config.json during `vercel dev`.
export default {fetch(request) {
  if (request.method !== 'GET') return json(405, {error: 'Method not allowed.'});
  return json(200, {...metadata, space: null, apiBase: '/api'});
}};
