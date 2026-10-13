import {createAppHandler} from '../server/vercel-app.mjs';
export default {fetch: createAppHandler('/api/chat')};
