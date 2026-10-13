import metadata from '../public/config.json' with {type: 'json'};
import {json} from '../cloud/vercel-gateway/proxy.mjs';
import {createAppHandler} from './vercel-app.mjs';

const chat = createAppHandler('/api/chat');
const health = createAppHandler('/api/health');
export default {fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/api/chat') return chat(request);
  if (path === '/api/health') return health(request);
  if (path !== '/config.json') return json(404, {error: 'API route not found.'});
  if (request.method !== 'GET') return json(405, {error: 'Method not allowed.'});
  return json(200, {...metadata, space: null, apiBase: '/api'});
}};
