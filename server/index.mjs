import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {timingSafeEqual} from 'node:crypto';
import {readEvents} from '../src/stream.ts';
import {createLlamaEngine} from './llama-engine.mjs';
import {RequestError,validateRequest} from './request.mjs';
import {createRequestRegistry} from './request-registry.mjs';
export {validateRequest} from './request.mjs';

const root=resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.xml':'application/xml','.txt':'text/plain'};
async function bodyJSON(req){
  const mediaType=String(req.headers['content-type']||'').split(';',1)[0].trim().toLowerCase();
  if(mediaType!=='application/json')throw new RequestError(415,'Send JSON.');
  let size=0;const parts=[];
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw new RequestError(413,'This message is too large. Please shorten it.');parts.push(chunk)}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw new RequestError(400,'Invalid message data.')}
}
export function createGateway(options={}){
  const accessToken=options.accessToken??process.env.GATEWAY_ACCESS_TOKEN;
  if(accessToken&&!/^[\w-]{32,256}$/.test(accessToken))throw Error('GATEWAY_ACCESS_TOKEN must be a 32–256 character service credential.');
  const fetchImpl=options.fetchImpl||fetch;
  const engine=options.engine||createLlamaEngine({origin:options.inference||process.env.LLAMA_URL||'http://127.0.0.1:8081',fetchImpl});
  const port=process.env.PORT||'8080';
  const apiOrigin=options.apiOrigin||process.env.PUBLIC_API_ORIGIN;
  if(apiOrigin){const url=new URL(apiOrigin);if(url.protocol!=='https:'||url.origin!==apiOrigin)throw Error('PUBLIC_API_ORIGIN must be an exact HTTPS origin.');}
  const origins=new Set(options.origins||[process.env.PUBLIC_ORIGIN||'https://offscript-ephemeral.sukiasyanmher7.chatgpt.site',...(apiOrigin?[apiOrigin]:[]),`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
  const queueLimit=options.queueLimit??32,queueTimeout=options.queueTimeout??300000,generationTimeout=options.generationTimeout??300000;
  const registry=createRequestRegistry();
  let active=false,healthy=true;const waiting=[];
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
  async function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'});res.end(JSON.stringify(data))}
  const server=http.createServer(async(req,res)=>{
    let acquired=false,ctrl,receipt,deadlineTimer,abort,workerStopped=true,started=false,completedSuccessfully=false;
    const control = outcome => ({...(receipt?{requestId:receipt.requestId,workerId:receipt.workerId}:{}),workerStopped,outcome});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const origin=req.headers.origin;
    if(origin){
      if(!origins.has(origin))return void await json(res,403,{error:'This website is not allowed to use this server.'});
      res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
    }
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Offscript-Client','Access-Control-Max-Age':'600'});return res.end()}
    try{
      const path=new URL(req.url,'http://localhost').pathname;
      if(path.startsWith('/api/')&&path!=='/api/health'&&accessToken){
        const actual=Buffer.from(String(req.headers.authorization||''));
        const expected=Buffer.from(`Bearer ${accessToken}`);
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new RequestError(401,'Service authentication is required.');
      }
      if(path.startsWith('/api/')||path==='/config.json')res.setHeader('X-Robots-Tag','noindex, nofollow');
      if(path==='/api/health'&&req.method==='GET'){
        const ready=healthy&&await engine.ready();
        return void await json(res,ready?200:503,{ready,queued:waiting.length,busy:active,protocol:4,workerId:registry.workerId,modes:['fast','deep']});
      }
      if(path==='/api/cancel'&&req.method==='POST'){
        if(!accessToken)throw new RequestError(503,'Service authentication is required.');
        return void await json(res,200,{control:await registry.cancel(await bodyJSON(req))});
      }
      if(path==='/api/chat'&&req.method==='POST'){
        res.setHeader('X-Offscript-Protocol','4');
        if(req.headers['x-offscript-client']!=='web')throw new RequestError(403,'Invalid client.');
        if(req.headers['x-offscript-request-id']!==undefined){
          if(!accessToken)throw new RequestError(503,'Service authentication is required.');
          receipt=registry.register(req.headers['x-offscript-request-id'],req.headers['x-offscript-worker-id'],req.headers['x-offscript-request-deadline']);
        }
        ctrl=receipt?.controller||new AbortController();abort=()=>ctrl.abort();res.once('close',abort);
        if(receipt)deadlineTimer=setTimeout(()=>ctrl.abort(),Math.max(0,receipt.expiresAt-Date.now()));
        const input=validateRequest(await bodyJSON(req));
        await acquire(ctrl.signal);acquired=true;
        if(!healthy)throw new RequestError(503,'The model needs to restart before another request.');
        // Slot cleanup must work before accepting content. Never expose slot endpoints.
        workerStopped=false;
        if(!await engine.dispose()){healthy=false;throw new RequestError(503,'The model server is not ready. Please try again later.')}
        workerStopped=true;
        if(options.thermalCheck&&await options.thermalCheck())throw new RequestError(503,'The laptop is cooling down. Try again in a moment.');
        const timeout=setTimeout(()=>ctrl.abort(new Error('The response took too long. Try Direct mode or a shorter reply.')),generationTimeout);
        const thermalTimer=options.thermalCheck?setInterval(async()=>{if(await options.thermalCheck())ctrl.abort(new Error('The laptop is cooling down. Try again in a moment.'))},1000):null;
        let completed=false;
        try{
          const prepared=await engine.prepare(input,ctrl.signal);
          if(ctrl.signal.aborted)throw new RequestError(499,'Request cancelled.');
          started=true;workerStopped=false;
          const response=await engine.generate(prepared,ctrl.signal);
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
          // Avoid forwarding inference diagnostics or prompt echoes to the public client.
          for await(const data of readEvents(response.body)){
            if(res.destroyed)break;
            if(data==='[DONE]'){completed=true;break}
            const event=JSON.parse(data);const choice=event.choices?.[0];
            if(event.error)throw Error('The model stopped unexpectedly.');
            if(choice){const delta={};if(typeof choice.delta?.content==='string')delta.content=choice.delta.content;if(choice.delta?.reasoning_content)delta.reasoning_content='thinking';
              if(!res.write(`data: ${JSON.stringify({choices:[{delta,finish_reason:choice.finish_reason||null}],usage:event.usage})}\n\n`))await once(res,'drain',{signal:ctrl.signal});
            }else if(event.usage)res.write(`data: ${JSON.stringify({usage:event.usage})}\n\n`);
          }
          if(!completed&&!res.destroyed)throw new RequestError(502,'The model stream ended before completion. Please try again.');
        }finally{
          clearTimeout(timeout);if(thermalTimer)clearInterval(thermalTimer);ctrl.abort();
          // Do not reuse a slot unless the old request's cache has been erased successfully.
          const cleared=await engine.dispose();
          workerStopped=cleared;
          if(!cleared)healthy=false;
        }
        if(!healthy)throw new RequestError(503,'The model needs to restart before another request.');
        // DONE means the request's model state has actually been cleared.
        completedSuccessfully=completed;
        if(!res.destroyed)res.end(`data: ${JSON.stringify({control:control('completed')})}\n\ndata: [DONE]\n\n`);
        return;
      }
      if(path==='/config.json'&&req.method==='GET'){
        const config=JSON.parse(await readFile(resolve(root,'config.json'),'utf8'));config.apiBase='/api';config.space=null;return void await json(res,200,config);
      }
      if(path.startsWith('/api/'))throw new RequestError(404,'API route not found.');
      if(req.method!=='GET'&&req.method!=='HEAD')throw new RequestError(405,'Method not allowed.');
      if(path==='/index.html'){res.writeHead(308,{Location:'/'+new URL(req.url,'http://localhost').search,'Cache-Control':'no-store'});return res.end()}
      let decoded;try{decoded=decodeURIComponent(path)}catch{throw new RequestError(400,'Invalid address.')}
      const file=resolve(root,decoded==='/'?'index.html':`.${decoded}`);let selected=file,status=200;
      if(file!==root&&!file.startsWith(root+'/'))throw new RequestError(400,'Invalid address.');
      try{if(!(await stat(selected)).isFile())throw Error()}catch{selected=resolve(root,'404.html');status=404}
      if(status===404||path==='/404.html')res.setHeader('X-Robots-Tag','noindex, follow');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://huggingface.co https://*.hf.space wss://*.hf.space; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
      res.writeHead(status,{'Content-Type':mime[extname(selected)]||'application/octet-stream','Cache-Control':/\/(assets|fonts)\//.test(path)?'public, max-age=86400':'no-store'});
      res.end(req.method==='HEAD'?undefined:await readFile(selected));
    }catch(error){
      if(res.destroyed)return;
      const message=error.status?error.message:ctrl?.signal.reason instanceof Error&&ctrl.signal.reason.name!=='AbortError'?ctrl.signal.reason.message:'The model connection failed. Please try again.';
      const proof=control(started?'failed':'rejected');
      if(res.headersSent){res.end(`data: ${JSON.stringify({error:message,control:proof})}\n\n`)}else await json(res,error.status||503,{error:message,control:proof});
    }finally{
      clearTimeout(deadlineTimer);if(abort)res.removeListener('close',abort);
      if(acquired)release();
      receipt?.finish(workerStopped,completedSuccessfully?'completed':started?'cancelled':'rejected');
    }
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
