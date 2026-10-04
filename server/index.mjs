import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {readEvents} from '../src/stream.ts';

const root=resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.woff2':'font/woff2','.xml':'application/xml','.txt':'text/plain'};
class RequestError extends Error{constructor(status,message){super(message);this.status=status}}
export function validateRequest(value){
  if(!value||typeof value!=='object'||!Array.isArray(value.messages)||!value.messages.length)throw new RequestError(400,'Send a message first.');
  if(![256,512,1024].includes(value.maxTokens)||typeof value.reasoned!=='boolean')throw new RequestError(400,'Invalid reply settings.');
  const messages=value.messages.map((m,i)=>{
    if(!m||m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'||!m.content.trim())throw new RequestError(400,'Invalid conversation. Clear the chat and try again.');
    return {role:m.role,content:m.content.trim()};
  });
  if(messages.length%2===0)throw new RequestError(400,'The last message must be a question.');
  return {messages,maxTokens:value.maxTokens,reasoned:value.reasoned};
}
async function bodyJSON(req){
  if(!String(req.headers['content-type']).startsWith('application/json'))throw new RequestError(415,'Send JSON.');
  let size=0;const parts=[];
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw new RequestError(413,'This message is too large. Please shorten it.');parts.push(chunk)}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw new RequestError(400,'Invalid message data.')}
}
export function createGateway(options={}){
  const inference=new URL(options.inference||process.env.LLAMA_URL||'http://127.0.0.1:8081');
  if(!['127.0.0.1','localhost','[::1]'].includes(inference.hostname))throw Error('LLAMA_URL must be loopback. Expose only the gateway through HTTPS.');
  const port=process.env.PORT||'8080';
  const origins=new Set(options.origins||[process.env.PUBLIC_ORIGIN||'https://offscript-ephemeral.sukiasyanmher7.chatgpt.site',`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
  const queueLimit=options.queueLimit??32,queueTimeout=options.queueTimeout??300000,generationTimeout=options.generationTimeout??300000;
  const fetchImpl=options.fetchImpl||fetch;let active=false,healthy=true;const waiting=[];
  async function acquire(signal){
    if(signal.aborted)throw new RequestError(499,'Request cancelled.');
    if(!active){active=true;return}
    if(waiting.length>=queueLimit)throw new RequestError(503,'The server is busy. Please try again shortly.');
    await new Promise((accept,reject)=>{
      let timer;const entry={grant(){cleanup();accept()}};
      function cleanup(){clearTimeout(timer);signal.removeEventListener('abort',cancel);const i=waiting.indexOf(entry);if(i>=0)waiting.splice(i,1)}
      function cancel(){cleanup();reject(new RequestError(499,'Request cancelled.'))}
      signal.addEventListener('abort',cancel,{once:true});
      timer=setTimeout(()=>{cleanup();reject(new RequestError(503,'The server queue is taking too long. Please try again later.'))},queueTimeout);
      waiting.push(entry);
    });
  }
  function release(){const next=waiting.shift();if(next)next.grant();else active=false}
  async function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
  const server=http.createServer(async(req,res)=>{
    let acquired=false,ctrl;res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const origin=req.headers.origin;
    if(origin){
      if(!origins.has(origin))return void await json(res,403,{error:'This website is not allowed to use this server.'});
      res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
    }
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Offscript-Client','Access-Control-Max-Age':'600'});return res.end()}
    try{
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/api/health'&&req.method==='GET'){
        let ready=false;try{const result=await fetchImpl(new URL('/health',inference),{signal:AbortSignal.timeout(3000)});ready=healthy&&result.ok}catch{}
        return void await json(res,ready?200:503,{ready,queued:waiting.length,busy:active});
      }
      if(path==='/api/chat'&&req.method==='POST'){
        if(req.headers['x-offscript-client']!=='web')throw new RequestError(403,'Invalid client.');
        const input=validateRequest(await bodyJSON(req));
        ctrl=new AbortController();const abort=()=>ctrl.abort();res.once('close',abort);
        await acquire(ctrl.signal);acquired=true;
        if(!healthy)throw new RequestError(503,'The model needs to restart before another request.');
        // Slot cleanup must work before accepting content. Never expose slot endpoints.
        const erased=await fetchImpl(new URL('/slots/0?action=erase',inference),{method:'POST',signal:AbortSignal.timeout(5000)});
        if(!erased.ok){healthy=false;throw new RequestError(503,'The model server is not ready. Please try again later.')}
        if(options.thermalCheck&&await options.thermalCheck())throw new RequestError(503,'The laptop is cooling down. Try again in a moment.');
        const timeout=setTimeout(()=>ctrl.abort(new Error('The response took too long. Try Direct mode or a shorter reply.')),generationTimeout);
        const thermalTimer=options.thermalCheck?setInterval(async()=>{if(await options.thermalCheck())ctrl.abort(new Error('The laptop is cooling down. Try again in a moment.'))},1000):null;
        try{
          // Apply the real embedded chat template and count actual tokens; no silent truncation.
          const templated=await fetchImpl(new URL('/apply-template',inference),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:input.messages,chat_template_kwargs:{enable_thinking:input.reasoned}}),signal:ctrl.signal});
          if(!templated.ok)throw new RequestError(502,'Could not prepare this conversation.');
          const {prompt}=await templated.json();
          const tokenized=await fetchImpl(new URL('/tokenize',inference),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:prompt,add_special:true}),signal:ctrl.signal});
          if(!tokenized.ok)throw new RequestError(502,'Could not check the conversation length.');
          const {tokens}=await tokenized.json();
          // Leave extra generation room for reasoning; both thinking and answer count toward this budget.
          const outputBudget=input.maxTokens+(input.reasoned?1024:0);
          if(!Array.isArray(tokens)||tokens.length+outputBudget>4096)throw new RequestError(422,'This conversation exceeds the laptop’s memory budget. Choose a shorter reply or clear the chat. Nothing was silently removed.');
          const response=await fetchImpl(new URL('/v1/chat/completions',inference),{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,body:JSON.stringify({model:'offscript',messages:input.messages,stream:true,stream_options:{include_usage:true},max_tokens:outputBudget,temperature:input.reasoned?0.6:0.7,top_p:input.reasoned?0.95:0.8,top_k:20,min_p:0,chat_template_kwargs:{enable_thinking:input.reasoned},cache_prompt:false,id_slot:0})});
          if(!response.ok||!response.body)throw new RequestError(502,'The model could not answer. Please try again.');
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
          // Avoid forwarding inference diagnostics or prompt echoes to the public client.
          for await(const data of readEvents(response.body)){
            if(res.destroyed)break;
            if(data==='[DONE]'){res.write('data: [DONE]\n\n');break}
            const event=JSON.parse(data);const choice=event.choices?.[0];
            if(event.error)throw Error('The model stopped unexpectedly.');
            if(choice){const delta={};if(typeof choice.delta?.content==='string')delta.content=choice.delta.content;if(choice.delta?.reasoning_content)delta.reasoning_content='thinking';
              if(!res.write(`data: ${JSON.stringify({choices:[{delta,finish_reason:choice.finish_reason||null}],usage:event.usage})}\n\n`))await Promise.race([once(res,'drain'),once(res,'close')]);
            }else if(event.usage)res.write(`data: ${JSON.stringify({usage:event.usage})}\n\n`);
          }
          res.end();
        }finally{
          clearTimeout(timeout);if(thermalTimer)clearInterval(thermalTimer);ctrl.abort();
          // Do not reuse a slot unless the old request's cache has been erased successfully.
          let cleared=false;for(let attempt=0;attempt<3&&!cleared;attempt++){try{const r=await fetchImpl(new URL('/slots/0?action=erase',inference),{method:'POST',signal:AbortSignal.timeout(5000)});cleared=r.ok}catch{}}
          if(!cleared)healthy=false;
          res.removeListener('close',abort);
        }
        return;
      }
      if(path==='/config.json'&&req.method==='GET'){
        const config=JSON.parse(await readFile(resolve(root,'config.json'),'utf8'));config.apiBase='/api';config.space=null;return void await json(res,200,config);
      }
      if(path.startsWith('/api/'))throw new RequestError(404,'API route not found.');
      if(req.method!=='GET'&&req.method!=='HEAD')throw new RequestError(405,'Method not allowed.');
      let decoded;try{decoded=decodeURIComponent(path)}catch{throw new RequestError(400,'Invalid address.')}
      const file=resolve(root,decoded==='/'?'index.html':`.${decoded}`);let selected=file,status=200;
      if(file!==root&&!file.startsWith(root+'/'))throw new RequestError(400,'Invalid address.');
      try{if(!(await stat(selected)).isFile())throw Error()}catch{selected=resolve(root,'404.html');status=404}
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://huggingface.co https://*.hf.space wss://*.hf.space; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
      res.writeHead(status,{'Content-Type':mime[extname(selected)]||'application/octet-stream','Cache-Control':/\/(assets|fonts)\//.test(path)?'public, max-age=86400':'no-store'});
      res.end(req.method==='HEAD'?undefined:await readFile(selected));
    }catch(error){
      if(res.destroyed)return;
      const message=ctrl?.signal.reason instanceof Error?ctrl.signal.reason.message:error.status?error.message:'The model connection failed. Please try again.';
      if(res.headersSent){res.end(`data: ${JSON.stringify({error:message})}\n\n`)}else await json(res,error.status||503,{error:message});
    }finally{if(acquired)release()}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {tooHot}=await import('../self-host/thermal.mjs');
  const gateway=createGateway({thermalCheck:tooHot});
  const port=Number(process.env.PORT||8080);gateway.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Offscript gateway ready at http://${process.env.HOST||'127.0.0.1'}:${port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{gateway.close();gateway.closeAllConnections()});
}
