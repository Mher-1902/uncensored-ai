import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createVerifier} from '../../cloud/vercel-gateway/auth.mjs';
import {createBridge} from '../../cloud/vercel-gateway/index.mjs';
import {createAppHandler} from '../../cloud/vercel-api/handler.mjs';
import {forward} from '../../cloud/vercel-gateway/proxy.mjs';
import configHandler from '../../cloud/vercel-api/index.mjs';
import {publicConfig} from '../../cloud/vercel-api/config.mjs';
const require = createRequire(new URL('../../cloud/vercel-gateway/package.json', import.meta.url));
const {generateKeyPair, exportJWK, SignJWT, createLocalJWKSet} = await import(require.resolve('jose'));

const payload={messages:[{role:'user',content:'Hello'}],maxTokens:256,reasoned:false};
const headers={'Content-Type':'application/json','X-Offscript-Client':'web'};
const request=(overrides={})=>new Request('https://app.test/api/chat',{method:'POST',headers,body:JSON.stringify(payload),...overrides});
const env={SUPABASE_URL:'https://project.supabase.co',SAMSUNG_API_ORIGIN:'https://server.test',SAMSUNG_GATEWAY_TOKEN:'s'.repeat(40)};
const sse=()=>new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});

test('public configuration uses same-domain API paths without leaking the old host or binding',async()=>{
  const response=await configHandler.fetch(new Request('https://app.test/config.json'));
  const config=await response.json();assert.equal(config.apiBase,'/api');assert.equal(config.space,null);
  assert.doesNotMatch(JSON.stringify(config),/tail8c9a09|GATEWAY_URL|TOKEN/);
  assert.equal((await configHandler.fetch(new Request('https://app.test/config.json',{method:'POST'}))).status,405);
});
test('account configuration publishes the browser key and explicitly enabled login methods only',()=>{
  const config=publicConfig({model:'Dummy',modelUrl:'https://model.test',internal:'must-not-publish'}, {
    SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+ 'a'.repeat(24),
    SUPABASE_AUTH_PROVIDERS:'google,github,google,other',SUPABASE_EMAIL_ENABLED:'true',SAMSUNG_GATEWAY_TOKEN:'dummy-private-credential',
  });
  assert.equal(config.requireAuth,true);assert.deepEqual(config.auth.providers,['google','github']);assert.equal(config.auth.emailEnabled,true);
  assert.doesNotMatch(JSON.stringify(config),/must-not-publish|dummy-private-credential/);
});
test('missing account setup or a non-publishable key leaves sign-in unavailable',()=>{
  for(const key of [undefined,'sb_secret_'+ 'a'.repeat(24),'legacy.jwt.value']) {
    assert.equal(publicConfig({},{SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:key}).auth,null);
  }
  const config=publicConfig({},{SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+ 'a'.repeat(24)});
  assert.deepEqual(config.auth.providers,[]);assert.equal(config.auth.emailEnabled,false);
});
test('larger Fast requests are published only after explicit deployment opt-in',()=>{
  for(const value of [undefined,'256','1024','true','512 '])assert.equal(publicConfig({},{FAST_REPLY_TOKENS:value}).fastReplyTokens,undefined);
  assert.equal(publicConfig({},{FAST_REPLY_TOKENS:'512'}).fastReplyTokens,512);
});

test('app reads a late runtime binding and preserves its URL base path',async()=>{
  const runtime={};let calls=0;
  const handler=createAppHandler('/api/chat',{env:runtime,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url.href,'https://internal.test/base/api/chat');
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer user-session');
    assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Origin,undefined);
    assert.deepEqual(JSON.parse(options.body),payload);return sse();
  }});
  assert.equal((await handler(request())).status,503);assert.equal(calls,0);
  runtime.GATEWAY_URL='https://internal.test/base/';
  const result=await handler(request({headers:{...headers,Authorization:'Bearer user-session',Cookie:'private=value'}}));
  assert.equal(result.headers.get('cache-control'),'no-store');assert.match(await result.text(),/\[DONE\]/);assert.equal(calls,1);
});
test('public routes reject foreign origins, invalid MIME, methods and paths before a binding call',async()=>{
  let calls=0;const handler=createAppHandler('/api/chat',{env:{GATEWAY_URL:'https://internal.test'},fetchImpl:()=>{calls++;return sse();}});
  assert.equal((await handler(request({headers:{...headers,Origin:'https://evil.test'}}))).status,403);
  assert.equal((await handler(request({headers:{...headers,'Content-Type':'application/json-evil'}}))).status,415);
  assert.equal((await handler(new Request('https://app.test/api/chat'))).status,405);
  assert.equal((await handler(new Request('https://app.test/api/admin'))).status,404);
  assert.equal(calls,0);
});
test('oversized and malformed JSON never reaches an internal service',async()=>{
  let calls=0;const handler=createAppHandler('/api/chat',{env:{GATEWAY_URL:'https://internal.test'},fetchImpl:()=>{calls++;return sse();}});
  assert.equal((await handler(request({body:'x'.repeat(65537)}))).status,413);
  assert.equal((await handler(request({body:'{'}))).status,400);assert.equal(calls,0);
});
test('an already-cancelled request releases its unread body without an upstream call',{timeout:1000},async t=>{
  const controller=new AbortController();let output,cancelled=0,calls=0;
  const body=new ReadableStream({start(value){output=value},cancel(){cancelled++}});
  t.after(()=>{try{output.close()}catch{}});
  const incoming=request({body,duplex:'half',signal:controller.signal});controller.abort();
  const response=await forward(incoming,'https://internal.test','api/chat',{timeoutMs:25,fetchImpl:()=>{calls++;return sse()}});
  assert.equal(response.status,503);assert.equal(cancelled,1);assert.equal(calls,0);
});
test('bridge stays offline for missing or invalid upstream configuration',async()=>{
  for(const config of [{},{...env,SAMSUNG_API_ORIGIN:'http://server.test'},{...env,SAMSUNG_API_ORIGIN:'https://user:secret@server.test'},{...env,SAMSUNG_GATEWAY_TOKEN:'short'},{...env,SAMSUNG_GATEWAY_TOKEN:' \r\n '},{...env,SAMSUNG_GATEWAY_TOKEN:'s'.repeat(20)+'\n'+'s'.repeat(20)},{...env,SUPABASE_URL:'https://evil.test'}]){
    const bridge=createBridge({env:config,fetchImpl:()=>{throw Error('Must not connect.');}});
    assert.equal((await bridge(request())).status,503);
  }
});
test('bridge requires a user session and replaces it with the Samsung service credential',async()=>{
  let calls=0;
  const bridge=createBridge({env,verify:async token=>{if(token!=='Bearer valid-user')throw Error('Invalid session.');},fetchImpl:async(url,options)=>{
    calls++;assert.equal(url.href,'https://server.test/api/chat');assert.equal(options.headers.Authorization,`Bearer ${env.SAMSUNG_GATEWAY_TOKEN}`);return sse();
  }});
  const rejected=await bridge(request());assert.equal(rejected.status,401);assert.equal((await rejected.json()).code,'session_required');assert.equal(calls,0);
  const response=await bridge(request({headers:{...headers,Authorization:'Bearer valid-user'}}));
  assert.equal(response.status,200);assert.match(await response.text(),/\[DONE\]/);assert.equal(calls,1);
});
test('clipboard whitespace around a service credential is removed before validation and forwarding',async()=>{
  for(const configured of [env.SAMSUNG_GATEWAY_TOKEN+'\n',' \t'+env.SAMSUNG_GATEWAY_TOKEN+'\r\n']){
    let calls=0;
    const bridge=createBridge({env:{...env,SAMSUNG_GATEWAY_TOKEN:configured},verify:async token=>{
      assert.equal(token,'Bearer valid-user');
    },fetchImpl:async(_url,options)=>{
      calls++;assert.equal(options.headers.Authorization,`Bearer ${env.SAMSUNG_GATEWAY_TOKEN}`);return sse();
    }});
    const response=await bridge(request({headers:{...headers,Authorization:'Bearer valid-user'}}));
    assert.equal(response.status,200);assert.match(await response.text(),/\[DONE\]/);assert.equal(calls,1);
  }
});
test('bridge forwards readiness only and never routes model administration',async()=>{
  let calls=0;const bridge=createBridge({env,verify:async()=>{},fetchImpl:async(url)=>{calls++;assert.equal(url.pathname,'/api/health');return Response.json({ready:true,queued:0,busy:false});}});
  const health=await bridge(new Request('https://internal.test/api/health'));assert.deepEqual(await health.json(),{ready:true,queued:0,busy:false});
  assert.equal((await bridge(new Request('https://internal.test/slots/0'))).status,404);assert.equal(calls,1);
});
test('signed Supabase sessions require the exact issuer, audience, role, expiry and signing key',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('ES256');
  const publicJwk={...await exportJWK(publicKey),kid:'test-key',alg:'ES256'};
  const verify=createVerifier(env.SUPABASE_URL,createLocalJWKSet({keys:[publicJwk]}));
  const claims={sub:'11111111-1111-4111-8111-111111111111',role:'authenticated'};
  const sign=async(extra={},key=privateKey)=>new SignJWT({...claims,...extra}).setProtectedHeader({alg:'ES256',kid:'test-key'}).setIssuer(`${env.SUPABASE_URL}/auth/v1`).setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(key);
  assert.equal(await verify(`Bearer ${await sign()}`),claims.sub);
  const other=await generateKeyPair('ES256');
  for(const token of [await sign({role:'service_role'}),await sign({is_anonymous:true}),await sign({sub:'invalid'}),await sign({},other.privateKey),await new SignJWT(claims).setProtectedHeader({alg:'ES256',kid:'test-key'}).setIssuer('https://other.supabase.co/auth/v1').setAudience('authenticated').setIssuedAt().setExpirationTime('5m').sign(privateKey),await new SignJWT(claims).setProtectedHeader({alg:'ES256',kid:'test-key'}).setIssuer(`${env.SUPABASE_URL}/auth/v1`).setAudience('other').setIssuedAt().setExpirationTime('5m').sign(privateKey),await new SignJWT(claims).setProtectedHeader({alg:'ES256',kid:'test-key'}).setIssuer(`${env.SUPABASE_URL}/auth/v1`).setAudience('authenticated').setIssuedAt().setExpirationTime(1).sign(privateKey)]){
    await assert.rejects(verify(`Bearer ${token}`));
  }
  await assert.rejects(verify('Bearer broken'));await assert.rejects(verify(null));
});
test('client disconnect cancels both binding and Samsung requests',async()=>{
  let samsungSignal;
  const bridge=createBridge({env,verify:async()=>{},fetchImpl:async(_url,options)=>{
    samsungSignal=options.signal;
    return new Response(new ReadableStream({start(output){output.enqueue(new TextEncoder().encode('data: first\n\n'));options.signal.addEventListener('abort',()=>output.close(),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  const app=createAppHandler('/api/chat',{env:{GATEWAY_URL:'https://internal.test'},fetchImpl:(url,options)=>bridge(new Request(url,options))});
  const response=await app(request());const reader=response.body.getReader();await reader.read();await reader.cancel();
  assert.equal(samsungSignal.aborted,true);
});
test('busy admission survives both forwarding layers with fixed safe wording',async()=>{
  const bridge=createBridge({env,verify:async()=>{},fetchImpl:async()=>Response.json({
    code:'model_busy',error:'private inference diagnostics',control:{workerId:'private-worker'},
  },{status:503,headers:{'Set-Cookie':'private=value'}})});
  const app=createAppHandler('/api/chat',{env:{GATEWAY_URL:'https://internal.test'},fetchImpl:(url,options)=>bridge(new Request(url,options))});
  const response=await app(request());assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'The model is busy. Please try again in a moment.',code:'model_busy'});
  assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('unknown busy codes and wrong-status busy claims remain redacted',async()=>{
  for(const [status,code] of [[503,'private_busy'],[500,'model_busy']]){
    const response=await forward(request(),'https://private.test','api/chat',{fetchImpl:async()=>Response.json({code,error:'private inference diagnostics'},{status})});
    assert.equal(response.status,status===500?502:503);assert.doesNotMatch(await response.text(),/private inference diagnostics|model_busy|private_busy/);
  }
});
test('proxy timeouts abort upstream requests and redact failures and response headers',async()=>{
  const failed=await forward(request(),'https://private.test','api/chat',{timeoutMs:10,fetchImpl:async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('private credential')),{once:true}))});
  assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/private credential/);
  const unsafe=await forward(request(),'https://private.test','api/chat',{fetchImpl:async()=>new Response('<html>error</html>',{status:500,headers:{'Set-Cookie':'secret=value'}})});
  assert.equal(unsafe.status,502);assert.equal(unsafe.headers.get('set-cookie'),null);assert.doesNotMatch(await unsafe.text(),/html/);
  const wrongType=await forward(request(),'https://private.test','api/chat',{fetchImpl:async()=>Response.json({ready:true})});assert.equal(wrongType.status,502);
});

test('only the managed JWT gate exposes a safe-to-refresh rejection through the public binding',async()=>{
  let nativeCalls=0;
  const bridge=createBridge({env,verify:async()=>{throw Error('expired')},fetchImpl:async()=>{nativeCalls++;return sse()}});
  const app=createAppHandler('/api/chat',{env:{GATEWAY_URL:'https://internal.test'},fetchImpl:async(url,options)=>bridge(new Request(url,options))});
  const result=await app(request());assert.equal(result.status,401);
  assert.deepEqual(await result.json(),{error:'Sign in before sending a message.',code:'session_required'});assert.equal(nativeCalls,0);
  const nativeRejected=createBridge({env,verify:async()=>{},fetchImpl:async()=>Response.json({code:'session_required',error:'private service details'},{status:401})});
  const rejected=await nativeRejected(request());assert.equal(rejected.status,401);
  const body=await rejected.json();assert.equal(body.code,undefined);assert.doesNotMatch(JSON.stringify(body),/private service details/);
});
