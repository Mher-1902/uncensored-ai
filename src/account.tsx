import {useEffect, useRef, useState} from 'react';
import type {Session, SupabaseClient} from '@supabase/supabase-js';
import {X} from 'lucide-react';
import type {AuthConfig} from './api';
import {AccountPrivacy} from './AccountPrivacy';
import {accountSessionProvider} from './session';
import {welcomeNeeded,rememberWelcome} from './welcome-preference';
import {ACCOUNT_ACTIVITY_FLUSH_MS,createAccountPersistence,guardedAccountReader,browserSessionLock,expireBrowserSessionIfInactive,type AccountPersistence} from './account-persistence';
import {accountSessionResumer,listenForAccountReturn} from './account-resume';

const RESTORE_CONNECTION_ERROR='Sign-in recovery is waiting for a connection.';

export function useAccount(config: AuthConfig | null | undefined) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [persistence,setPersistence]=useState<AccountPersistence|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [needsSignIn,setNeedsSignIn]=useState(false);
  const [welcomeUser,setWelcomeUser]=useState<string|null>(null);
  const [welcomeCandidate,setWelcomeCandidate]=useState<{session:Session;config:{url:string;publishableKey:string}}|null>(null);
  const welcomedUser=useRef<string|null>(null);
  useEffect(() => {
    setClient(null); setSession(null);setPersistence(null); setError(''); setRecovery(false); setLoading(false);setWelcomeUser(null);setWelcomeCandidate(null);welcomedUser.current=null;setNeedsSignIn(false);
    if (!config) return;
    let disposed = false, cleanup = () => {};
    setLoading(true);
    void import('@supabase/supabase-js').then(async ({createClient}) => {
      if (disposed) return;
      let local:Storage|undefined,tab:Storage|undefined,sharedLock:ReturnType<typeof browserSessionLock>|undefined;
      try{local=window.localStorage;}catch{}
      try{tab=window.sessionStorage;}catch{}
      try{if(navigator.locks)sharedLock=browserSessionLock(navigator.locks);}catch{}
      let instance:SupabaseClient|undefined,hasSession=false,expired=false;
      const expire=()=>{
        if(disposed)return;
        expireBrowserSessionIfInactive(saved,()=>{
          expired=true;hasSession=false;setSession(null);setNeedsSignIn(true);setRecovery(false);setWelcomeUser(null);setWelcomeCandidate(null);welcomedUser.current=null;
        });
      };
      const saved=createAccountPersistence({url:config.url,persistent:local,temporary:tab,sharedLock,onExpired:expire});
      instance = createClient(config.url, config.publishableKey, {
        auth: {persistSession: true, storageKey:saved.storageKey,storage:saved.storage,lock:saved.lock, flowType: 'pkce', detectSessionInUrl: true, autoRefreshToken: true},
      });
      const {data: {subscription}} = instance.auth.onAuthStateChange((event, value) => {
        if (disposed) return;
        if(value&&!saved.accepts(value)){if(hasSession)expire();return;}
        hasSession=Boolean(value);setSession(value);
        if(event==='SIGNED_IN'&&value)setNeedsSignIn(false);
        if(event==='SIGNED_IN'&&value)expired=false;
        if(event==='SIGNED_IN'&&value&&welcomedUser.current!==value.user.id){welcomedUser.current=value.user.id;setWelcomeUser(null);setWelcomeCandidate({session:value,config:{url:config.url,publishableKey:config.publishableKey}})}
        if (event === 'PASSWORD_RECOVERY') setRecovery(true);
        if (event === 'SIGNED_OUT') {setNeedsSignIn(expired);setRecovery(false);setWelcomeUser(null);setWelcomeCandidate(null);welcomedUser.current=null;}
      });
      let flushTimer:ReturnType<typeof setTimeout>|undefined;
      const resumer=accountSessionResumer(instance.auth,saved,value=>{
        if(disposed)return;
        hasSession=true;expired=false;setSession(value);setNeedsSignIn(false);
        setError(previous=>previous===RESTORE_CONNECTION_ERROR?'':previous);
      });
      const activity=()=>{
        if(disposed||document.visibilityState!=='visible')return;
        // touch() checks expiry before extending from a real event.
        void saved.touch().catch(()=>{});
        if(flushTimer===undefined)flushTimer=setTimeout(()=>{flushTimer=undefined;void saved.flush().catch(()=>{});},ACCOUNT_ACTIVITY_FLUSH_MS);
      };
      const inputActivity=(event:Event)=>{if(event.isTrusted)activity();};
      const foreground=()=>{if(document.visibilityState==='visible'){if(saved.isActive()){activity();void resumer.resume();}else if(hasSession)expire();}};
      const pagehide=()=>saved.flushForPageHide();
      const visibility=()=>{if(document.visibilityState==='visible')foreground();else pagehide();};
      const storageChanged=(event:StorageEvent)=>{
        if(!saved.watches(event.key))return;
        if(!saved.isActive()){if(hasSession)expire();return;}
        void instance?.auth.getSession().then(({data})=>{if(!disposed&&data.session&&saved.accepts(data.session)){hasSession=true;setSession(data.session);}}).catch(()=>{});
      };
      window.addEventListener('pointerdown',inputActivity,{passive:true});window.addEventListener('keydown',inputActivity);
      window.addEventListener('focus',foreground);window.addEventListener('pagehide',pagehide);window.addEventListener('storage',storageChanged);document.addEventListener('visibilitychange',visibility);
      const stopReturnEvents=listenForAccountReturn(window,foreground);
      const expiryTimer=setInterval(()=>{if(hasSession&&!saved.isActive())expire();},ACCOUNT_ACTIVITY_FLUSH_MS);
      cleanup = () => {
        saved.flushForPageHide();resumer.dispose();stopReturnEvents();saved.dispose();subscription.unsubscribe();instance?.auth.stopAutoRefresh();clearTimeout(flushTimer);clearInterval(expiryTimer);
        window.removeEventListener('pointerdown',inputActivity);window.removeEventListener('keydown',inputActivity);window.removeEventListener('focus',foreground);window.removeEventListener('pagehide',pagehide);window.removeEventListener('storage',storageChanged);document.removeEventListener('visibilitychange',visibility);
      };
      setPersistence(saved);setClient(instance);
      const {data, error: failure} = await instance.auth.getSession();
      if (!disposed) {
        const restored=data.session&&saved.accepts(data.session)?data.session:null;
        hasSession=Boolean(restored);setSession(restored);
        if (failure) setError(saved.isActive()?RESTORE_CONNECTION_ERROR:'Your sign-in session could not be restored. Please sign in again.');
        setLoading(false);
        if(restored)foreground();
      }
    }).catch(() => {if (!disposed) {setError('Sign-in is unavailable. Please try again.'); setLoading(false);}});
    return () => {disposed = true; cleanup();};
  }, [config?.url, config?.publishableKey]);
  useEffect(()=>{
    let disposed=false;
    if(welcomeCandidate&&welcomeCandidate.config.url===config?.url&&welcomeCandidate.config.publishableKey===config?.publishableKey)void welcomeNeeded(welcomeCandidate.session,welcomeCandidate.config).then(needed=>{
      if(!disposed)setWelcomeUser(needed?welcomeCandidate.session.user.id:null);
    });
    return ()=>{disposed=true;};
  },[welcomeCandidate,config?.url,config?.publishableKey]);
  const chatSession=accountSessionProvider(client&&persistence?guardedAccountReader(client.auth,persistence):null,session?.user.id);
  async function accessToken(){return (await chatSession())?.accessToken||null;}
  function dismissWelcome(){
    setWelcomeUser(null);
    if(client&&session&&welcomeCandidate&&welcomeCandidate.session.user.id===session.user.id&&welcomeCandidate.config.url===config?.url&&welcomeCandidate.config.publishableKey===config?.publishableKey)void rememberWelcome(client.auth,session.user.id,welcomeCandidate.config);
  }
  async function beginSignIn(redirect=false,email=false){if(!persistence)throw Error('Sign-in is not ready yet.');return persistence.beginSignIn(redirect,email);}
  async function cancelSignIn(attemptId?:string){await persistence?.cancelSignIn(attemptId);}
  return {client, session, loading, error, recovery, setRecovery, accessToken,chatSession,beginSignIn,cancelSignIn,needsSignIn,requireSignIn:()=>setNeedsSignIn(true), authOrigin:config?.url,providers: config?.providers || [], emailEnabled: Boolean(config?.emailEnabled),welcome:Boolean(session&&!needsSignIn&&welcomeUser===session.user.id),dismissWelcome};
}

type Account = ReturnType<typeof useAccount>;
type Mode = 'signin' | 'signup' | 'reset' | 'password';
export function AccountDialog({account, open, onClose, beforeOAuth, hasDraft=false}: {account: Account; open: boolean; onClose: () => void; beforeOAuth?:()=>void|(()=>void); hasDraft?:boolean}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const attempt = useRef(0);
  const latestBeforeOAuth=useRef(beforeOAuth);latestBeforeOAuth.current=beforeOAuth;
  const cancelDraft=useRef<(()=>void)|undefined>(undefined);
  const authAttempt=useRef<string|undefined>(undefined);
  function cancelHandoff(){cancelDraft.current?.();cancelDraft.current=undefined;const id=authAttempt.current;authAttempt.current=undefined;if(id)void account.cancelSignIn(id).catch(()=>{});}
  useEffect(() => {
    if (open) {setMode(account.recovery ? 'password' : 'signin'); dialog.current?.showModal();}
    else {dialog.current?.close(); attempt.current++; cancelHandoff(); setPassword(''); setError(''); setNotice(''); setPending(false);}
  }, [open]);
  useEffect(() => {if (account.recovery) setMode('password');}, [account.recovery]);
  useEffect(() => {if (open && account.session && !account.needsSignIn && !account.recovery && (mode === 'signin' || mode === 'signup')) onClose();}, [open, account.session, account.needsSignIn, account.recovery, mode, onClose]);
  function choose(value: Mode) {attempt.current++; cancelHandoff(); setPending(false); setPassword(''); setError(''); setNotice(''); setMode(value);}
  function close() {attempt.current++; cancelHandoff(); setPassword(''); onClose();}
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!account.client || pending) return;
    const current = ++attempt.current, client = account.client;
    let initiated:string|undefined;
    setPending(true); setError(''); setNotice('');
    const redirectTo = new URL('/', location.origin).href;
    try {
      if (mode === 'signin') {
        initiated=await account.beginSignIn();if(current!==attempt.current){await account.cancelSignIn(initiated);return;}authAttempt.current=initiated;
        const {error: failure} = await client.auth.signInWithPassword({email: email.trim(), password});
        if (failure) throw failure;
      } else if (mode === 'signup') {
        initiated=await account.beginSignIn(false,true);if(current!==attempt.current){await account.cancelSignIn(initiated);return;}authAttempt.current=initiated;
        const {data,error: failure} = await client.auth.signUp({email: email.trim(), password, options: {emailRedirectTo: redirectTo}});
        if (failure) throw failure;
        // A requested confirmation email may complete after this dialog closes.
        if(!data.session&&authAttempt.current===initiated)authAttempt.current=undefined;
        if (current === attempt.current) setNotice('Check your email to confirm your account, then sign in. If you already have an account, use Sign in or Forgot password.');
      } else if (mode === 'reset') {
        initiated=await account.beginSignIn(true,true);if(current!==attempt.current){await account.cancelSignIn(initiated);return;}authAttempt.current=initiated;
        const {error: failure} = await client.auth.resetPasswordForEmail(email.trim(), {redirectTo});
        if (failure) throw failure;
        if(authAttempt.current===initiated)authAttempt.current=undefined;
        if (current === attempt.current) setNotice('If this address has an account, a password-reset link will arrive by email. Open it in this browser.');
      } else {
        const {error: failure} = await client.auth.updateUser({password});
        if (failure) throw failure;
        if (current === attempt.current) {account.setRecovery(false); setNotice('Your password has been updated.');}
      }
    } catch (failure) {
      if(current===attempt.current)cancelHandoff();else if(initiated)void account.cancelSignIn(initiated).catch(()=>{});
      if (current === attempt.current) setError(failure instanceof Error ? failure.message : 'The account request could not be completed.');
    } finally {
      if (current === attempt.current) {setPending(false); setPassword('');}
    }
  }
  async function oauth(provider: 'google' | 'github') {
    if (!account.client || pending) return;
    const current = ++attempt.current;
    let initiated:string|undefined;
    setPending(true); setError(''); setNotice('');
    try {
      initiated=await account.beginSignIn(true);if(current!==attempt.current){await account.cancelSignIn(initiated);return;}authAttempt.current=initiated;
      const {data,error: failure} = await account.client.auth.signInWithOAuth({provider, options: {redirectTo: new URL('/', location.origin).href,skipBrowserRedirect:true}});
      if (failure) throw failure;
      if(current!==attempt.current){if(initiated)await account.cancelSignIn(initiated);return;}
      if(!data.url)throw Error('Sign-in could not start. Please try again.');
      const destination=new URL(data.url);
      if(destination.origin!==account.authOrigin||destination.pathname!=='/auth/v1/authorize')throw Error('Sign-in returned an unexpected destination. Please try again.');
      cancelDraft.current=latestBeforeOAuth.current?.()||undefined;
      location.assign(destination.href);
    } catch (failure) {
      if (current === attempt.current) {cancelHandoff();setError(failure instanceof Error ? failure.message : 'Sign-in could not start. Please try again.');}
      else if(initiated)void account.cancelSignIn(initiated).catch(()=>{});
    } finally {if (current === attempt.current) setPending(false);}
  }
  const title = {signin: 'Your next question starts here.', signup: 'Make room for a question.', reset: 'Reset your password.', password: 'Choose a new password.'}[mode];
  return <dialog className="account-dialog" ref={dialog} aria-labelledby="account-title" onCancel={close} onClick={event => {if (event.target === event.currentTarget) close();}}>
    <div className="dialog-heading"><h2 id="account-title">{title}</h2><button className="icon-button" type="button" aria-label="Close account form" onClick={close}><X size={21}/></button></div>
    <p>{mode === 'signup' ? 'Create an account for temporary conversations.' : mode === 'reset' ? 'We’ll send a link to the email address on your account.' : mode === 'password' ? 'Use a unique password with at least 12 characters.' : 'Sign in or create an account with a provider below.'}</p>
    {account.needsSignIn&&<p role="status">Your session expired. Your reply stays on this page until you leave or reload. Copy anything you need before continuing to sign in.</p>}
    {(mode==='signin'||mode==='signup')&&<AccountPrivacy signup={mode==='signup'}/>}
    {hasDraft&&(mode==='signin'||mode==='signup')&&<p className="muted">Your unsent prompt will wait in this tab for up to 10 minutes while you sign in. It returns for review; it is never sent automatically.</p>}
    {account.error && <p className="account-error" role="alert">{account.error}</p>}
    {!account.client ? <p role="status">{account.loading ? 'Preparing sign-in…' : 'Account setup is not ready yet. Please check back soon.'}</p> : <>
      {(mode === 'signin' || mode === 'signup') && <div className="account-providers">{account.providers.map(provider => <button type="button" className="account-provider" key={provider} disabled={pending} onClick={() => void oauth(provider)}>Continue with {provider === 'github' ? 'GitHub' : 'Google'}</button>)}</div>}
      {!account.emailEnabled && !account.providers.length && <p role="status">Sign-in is being configured. Please check back soon.</p>}
      {!account.emailEnabled && error && <p className="account-error" role="alert">{error}</p>}
      {account.emailEnabled && <form onSubmit={submit}>
      {mode !== 'password' && <label>Email<input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} required disabled={pending}/></label>}
      {mode !== 'reset' && <label>{mode === 'password' ? 'New password' : 'Password'}<input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} minLength={mode === 'signin' ? undefined : 12} maxLength={128} required disabled={pending}/></label>}
      {error && <p className="account-error" role="alert">{error}</p>}{notice && <p className="account-notice" role="status">{notice}</p>}
      <button className="dialog-done" disabled={pending}>{pending ? 'Please wait…' : {signin: 'Sign in', signup: 'Create account', reset: 'Send reset link', password: 'Update password'}[mode]}</button>
    </form>}
    {mode !== 'password' && <div className="account-links">{mode !== 'signin' && <button type="button" onClick={() => choose('signin')} disabled={pending}>Sign in</button>}{mode !== 'signup' && <button type="button" onClick={() => choose('signup')} disabled={pending}>Create account</button>}{account.emailEnabled&&mode === 'signin' && <button type="button" onClick={() => choose('reset')} disabled={pending}>Forgot password?</button>}</div>}
    </>}
    <p className="muted">Your account is saved. Chats clear when you leave or reload.</p>
  </dialog>;
}
