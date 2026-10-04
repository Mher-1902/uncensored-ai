import {readFile,writeFile} from 'node:fs/promises';
const argument=process.argv[2];if(!argument)throw Error('Supply the verified HTTPS API base ending in /api.');
const url=new URL(argument);if(url.protocol!=='https:'||!url.pathname.endsWith('/api')||url.username||url.password||url.search||url.hash)throw Error('Use a plain HTTPS URL ending in /api.');
const r=await fetch(`${url.href}/health`,{signal:AbortSignal.timeout(15000)});if(!r.ok||(await r.json()).ready!==true)throw Error('The model is not healthy. Website configuration was not changed.');
const cors=await fetch(`${url.href}/health`,{headers:{Origin:'https://offscript-ephemeral.sukiasyanmher7.chatgpt.site'},signal:AbortSignal.timeout(15000)});
if(cors.headers.get('access-control-allow-origin')!=='https://offscript-ephemeral.sukiasyanmher7.chatgpt.site')throw Error('Server CORS does not allow the published website.');
const config=JSON.parse(await readFile('public/config.json','utf8'));config.apiBase=url.href;config.space=null;
await writeFile('public/config.json',JSON.stringify(config)+'\n');
console.log('Healthy model connection saved. Rebuild and publish the website to activate it.');
