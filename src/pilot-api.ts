import type {SiteConfig} from './api';

export type PilotAccount={
  plan:'free';status:'pending'|'active'|'suspended';eligibility:'pending'|'eligible'|'ineligible';
  policies:{termsVersion:string;privacyVersion:string;published:boolean;accepted:boolean};
  usage:{requestsRemaining:number;deepRemaining:number;tokensRemaining:number};
};
export function parsePilotAccount(value:unknown):PilotAccount{
  const data=value as PilotAccount;
  if(!data||data.plan!=='free'||!['pending','active','suspended'].includes(data.status)||!['pending','eligible','ineligible'].includes(data.eligibility)
    ||!data.policies||![data.policies.termsVersion,data.policies.privacyVersion].every(v=>typeof v==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(v))
    ||typeof data.policies.published!=='boolean'||typeof data.policies.accepted!=='boolean'||!data.usage
    ||![data.usage.requestsRemaining,data.usage.deepRemaining,data.usage.tokensRemaining].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=100000000))throw Error('Account details are unavailable. Please try again.');
  return {plan:data.plan,status:data.status,eligibility:data.eligibility,policies:{termsVersion:data.policies.termsVersion,privacyVersion:data.policies.privacyVersion,published:data.policies.published,accepted:data.policies.accepted},usage:{requestsRemaining:data.usage.requestsRemaining,deepRemaining:data.usage.deepRemaining,tokensRemaining:data.usage.tokensRemaining}};
}
export function canUsePilot(data:PilotAccount|null,deep=false){
  return Boolean(data&&data.status==='active'&&data.eligibility==='eligible'&&data.policies.published&&data.policies.accepted
    &&data.usage.requestsRemaining>0&&data.usage.tokensRemaining>=4096&&(!deep||data.usage.deepRemaining>0));
}
export async function pilotAccount(config:SiteConfig,token:string,signal:AbortSignal,accept?:PilotAccount['policies']){
  if(!config.accountControl||!config.apiBase||new URL(config.apiBase,location.origin).origin!==location.origin)throw Error('Account controls require this website’s own API.');
  if(!token)throw Error('Sign in to view your account.');
  const response=await fetch(`${config.apiBase}/${accept?'acceptance':'account'}`,{
    method:accept?'POST':'GET',signal,cache:'no-store',headers:{Authorization:`Bearer ${token}`,...(accept?{'Content-Type':'application/json','X-Offscript-Client':'web'}:{})},
    ...(accept?{body:JSON.stringify({accepted:true,termsVersion:accept.termsVersion,privacyVersion:accept.privacyVersion})}:{})});
  const value=await response.json().catch(()=>null);
  if(!response.ok)throw Error(value?.error||'Account details are unavailable. Please try again.');
  return parsePilotAccount(value);
}
