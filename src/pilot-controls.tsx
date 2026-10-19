import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import type {SiteConfig} from './api';
import {pilotAccount,type PilotAccount} from './pilot-api';
import {policyLinks} from './policy-documents';

export function usePilotControls(config:SiteConfig|null,user:string|undefined,accessToken:()=>Promise<string|null>){
  const [data,setData]=useState<PilotAccount|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const request=useRef<AbortController|null>(null),revision=useRef(0);
  async function load(accept?:PilotAccount['policies']){
    request.current?.abort();const current=++revision.current;
    if(!config?.accountControl||!user){setData(null);setLoading(false);setError('');return}
    const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    try{
      const token=await accessToken();controller.signal.throwIfAborted();
      const value=await pilotAccount(config,token||'',controller.signal,accept);
      if(current===revision.current)setData(value);
    }catch(failure){if(current===revision.current&&!controller.signal.aborted)setError(failure instanceof Error?failure.message:'Account details are unavailable.');}
    finally{if(current===revision.current)setLoading(false)}
  }
  useEffect(()=>{
    setData(null);void load();
    return()=>{revision.current++;request.current?.abort()};
  },[config?.accountControl,user]);
  return {data,loading,error,refresh:()=>load(),accept:()=>data?load(data.policies):Promise.resolve()};
}

export function PilotDialog({controls,open,onClose,onSignOut,signingOut}:{controls:ReturnType<typeof usePilotControls>;open:boolean;onClose:()=>void;onSignOut:()=>void;signingOut:boolean}){
  const dialog=useRef<HTMLDialogElement>(null),[checked,setChecked]=useState(false);
  const data=controls.data,links=data?policyLinks(data.policies.termsVersion,data.policies.privacyVersion):null;
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();setChecked(false)},[open,data?.policies.termsVersion,data?.policies.privacyVersion]);
  return <dialog className="pilot-dialog" ref={dialog} aria-labelledby="pilot-title" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
    <div className="dialog-heading"><h2 id="pilot-title">Your account</h2><button className="icon-button" aria-label="Close account" onClick={onClose}><X size={21}/></button></div>
    {controls.loading&&<p role="status">Loading your account…</p>}
    {controls.error&&<p className="account-error" role="alert">{controls.error}</p>}
    {data&&<>
      <p>Free account. Chats stay temporary.</p>
      {data.status==='pending'?<p role="status">Your account is waiting for pilot access.</p>:data.status==='suspended'?<p role="status">Access to this account is paused. Contact <a href="mailto:sukiasyanmher7@gmail.com">support</a>.</p>:data.eligibility!=='eligible'?<p role="status">Your access eligibility still needs to be confirmed.</p>:null}
      <dl><div><dt>Daily requests remaining</dt><dd>{data.usage.requestsRemaining}</dd></div><div><dt>Deep Think remaining</dt><dd>{data.usage.deepRemaining}</dd></div></dl>
      {!data.policies.published||!links?<p>The service policies are being prepared. Policy acceptance is not available yet.</p>:data.policies.accepted?<p>You have accepted the current Terms of Use and acknowledged the Privacy Policy. <a href={links.terms} target="_blank" rel="noopener noreferrer">Terms</a> · <a href={links.privacy} target="_blank" rel="noopener noreferrer">Privacy</a></p>:<form onSubmit={e=>{e.preventDefault();if(checked&&!controls.loading)void controls.accept()}}>
        <label className="policy-choice"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} disabled={controls.loading}/><span>I agree to the <a href={links.terms} target="_blank" rel="noopener noreferrer">Terms of Use</a> and acknowledge the <a href={links.privacy} target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</span></label>
        <button className="dialog-done" disabled={!checked||controls.loading}>Save acknowledgement</button>
      </form>}
    </>}
    <div className="account-links"><button onClick={()=>void controls.refresh()} disabled={controls.loading}>Refresh account</button><button onClick={onSignOut} disabled={signingOut}>{signingOut?'Signing out…':'Sign out'}</button></div>
  </dialog>;
}
