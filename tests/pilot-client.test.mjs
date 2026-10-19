import test from 'node:test';
import assert from 'node:assert/strict';
import {canUsePilot,parsePilotAccount,pilotAccount} from '../src/pilot-api.ts';
import {policyLinks} from '../src/policy-documents.ts';
import {publicConfig} from '../cloud/vercel-api/config.mjs';
const sample={plan:'free',status:'active',eligibility:'eligible',policies:{termsVersion:'fixture-v1',privacyVersion:'fixture-v1',published:true,accepted:true},usage:{requestsRemaining:10,deepRemaining:2,tokensRemaining:20000}};
const config={apiBase:'https://app.test/api',space:null,accountControl:true};
function location(t){const prior=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://app.test'}});t.after(()=>{if(prior)Object.defineProperty(globalThis,'location',prior);else delete globalThis.location})}
test('pilot UI is opted in explicitly and no draft document becomes an agreement',()=>{
  for(const value of [undefined,'false','TRUE','yes'])assert.equal(publicConfig({}, {PILOT_ACCOUNT_CONTROL:value}).accountControl,undefined);
  assert.equal(publicConfig({}, {PILOT_ACCOUNT_CONTROL:'true'}).accountControl,true);
  assert.equal(policyLinks('2026-10-17-draft','2026-10-17-draft'),null);
});
test('all serving gates and remaining allowances matter to the client',()=>{
  assert.equal(canUsePilot(sample,true),true);
  for(const value of [null,{...sample,status:'pending'},{...sample,status:'suspended'},{...sample,eligibility:'pending'},{...sample,policies:{...sample.policies,published:false}},{...sample,policies:{...sample.policies,accepted:false}},{...sample,usage:{...sample.usage,requestsRemaining:0}},{...sample,usage:{...sample.usage,tokensRemaining:4095}}])assert.equal(canUsePilot(value),false);
  assert.equal(canUsePilot({...sample,usage:{...sample.usage,deepRemaining:0}},true),false);
  assert.equal(canUsePilot({...sample,usage:{...sample.usage,deepRemaining:0}},false),true);
});
test('invalid account details fail closed and unrelated fields are discarded',()=>{
  assert.deepEqual(parsePilotAccount({...sample,privateExtra:'not retained'}),sample);
  for(const value of [null,{}, {...sample,plan:'admin'}, {...sample,eligibility:'anything'}, {...sample,usage:{...sample.usage,tokensRemaining:Infinity}}, {...sample,policies:{...sample.policies,termsVersion:'../../private'}}])assert.throws(()=>parsePilotAccount(value));
});
test('account and acceptance use only the same-origin API and exact server policy versions',async t=>{
  location(t);const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,...options});return Response.json(sample)});
  await pilotAccount(config,'fixture-session',new AbortController().signal);
  await pilotAccount(config,'fixture-session',new AbortController().signal,sample.policies);
  assert.equal(calls[0].url,'https://app.test/api/account');assert.equal(calls[0].method,'GET');
  assert.equal(calls[1].url,'https://app.test/api/acceptance');assert.equal(calls[1].headers.Authorization,'Bearer fixture-session');
  assert.deepEqual(JSON.parse(calls[1].body),{accepted:true,termsVersion:'fixture-v1',privacyVersion:'fixture-v1'});
  await assert.rejects(pilotAccount({...config,apiBase:'https://other.test/api'},'fixture-session',new AbortController().signal),/own API/);
  await assert.rejects(pilotAccount(config,'',new AbortController().signal),/Sign in/);
  assert.equal(calls.length,2);
});
test('policy changes and unavailable account controls remain errors rather than granting access',async t=>{
  location(t);t.mock.method(globalThis,'fetch',async()=>Response.json({error:'The policies changed.'},{status:409}));
  await assert.rejects(pilotAccount(config,'fixture-session',new AbortController().signal,sample.policies),/policies changed/);
});
