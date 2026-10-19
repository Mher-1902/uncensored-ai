import {useEffect, useRef, useState} from 'react';
import type {Session, SupabaseClient} from '@supabase/supabase-js';
import {X} from 'lucide-react';
import type {AuthConfig} from './api';
import {PrivacyContent,PRIVACY_PATH} from './Privacy';

export function useAccount(config: AuthConfig | null | undefined) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [welcomeUser,setWelcomeUser]=useState<string|null>(null);
  const welcomedUser=useRef<string|null>(null);
  useEffect(() => {
    setClient(null); setSession(null); setError(''); setRecovery(false); setLoading(false);setWelcomeUser(null);welcomedUser.current=null;
    if (!config) return;
    let disposed = false, cleanup = () => {};
    setLoading(true);
    void import('@supabase/supabase-js').then(async ({createClient}) => {
      if (disposed) return;
      const instance = createClient(config.url, config.publishableKey, {
        auth: {persistSession: true, storage: window.sessionStorage, flowType: 'pkce', detectSessionInUrl: true, autoRefreshToken: true},
      });
      const {data: {subscription}} = instance.auth.onAuthStateChange((event, value) => {
        if (disposed) return;
        setSession(value);
        if(event==='SIGNED_IN'&&value&&welcomedUser.current!==value.user.id){welcomedUser.current=value.user.id;setWelcomeUser(value.user.id)}
        if (event === 'PASSWORD_RECOVERY') setRecovery(true);
        if (event === 'SIGNED_OUT') {setRecovery(false);setWelcomeUser(null);welcomedUser.current=null;}
      });
      cleanup = () => {subscription.unsubscribe(); instance.auth.stopAutoRefresh();};
      setClient(instance);
      const {data, error: failure} = await instance.auth.getSession();
      if (!disposed) {
        setSession(data.session);
        if (failure) setError('Your sign-in session could not be restored. Please sign in again.');
        setLoading(false);
      }
    }).catch(() => {if (!disposed) {setError('Sign-in is unavailable. Please try again.'); setLoading(false);}});
    return () => {disposed = true; cleanup();};
  }, [config?.url, config?.publishableKey]);
  async function accessToken() {
    if (!client) return null;
    const {data, error: failure} = await client.auth.getSession();
    if (failure) throw Error('Your session expired. Please sign in again.');
    return data.session?.access_token || null;
  }
  return {client, session, loading, error, recovery, setRecovery, accessToken, providers: config?.providers || [], emailEnabled: Boolean(config?.emailEnabled),welcome:Boolean(session&&welcomeUser===session.user.id),dismissWelcome:()=>setWelcomeUser(null)};
}

type Account = ReturnType<typeof useAccount>;
type Mode = 'signin' | 'signup' | 'reset' | 'password';
export function AccountDialog({account, open, onClose}: {account: Account; open: boolean; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const attempt = useRef(0);
  useEffect(() => {
    if (open) {setMode(account.recovery ? 'password' : 'signin'); dialog.current?.showModal();}
    else {dialog.current?.close(); attempt.current++; setPassword(''); setError(''); setNotice(''); setPending(false);}
  }, [open]);
  useEffect(() => {if (account.recovery) setMode('password');}, [account.recovery]);
  useEffect(() => {if (open && account.session && !account.recovery && (mode === 'signin' || mode === 'signup')) onClose();}, [open, account.session, account.recovery, mode, onClose]);
  function choose(value: Mode) {attempt.current++; setPending(false); setPassword(''); setError(''); setNotice(''); setMode(value);}
  function close() {attempt.current++; setPassword(''); onClose();}
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!account.client || pending) return;
    const current = ++attempt.current, client = account.client;
    setPending(true); setError(''); setNotice('');
    const redirectTo = new URL('/', location.origin).href;
    try {
      if (mode === 'signin') {
        const {error: failure} = await client.auth.signInWithPassword({email: email.trim(), password});
        if (failure) throw failure;
      } else if (mode === 'signup') {
        const {error: failure} = await client.auth.signUp({email: email.trim(), password, options: {emailRedirectTo: redirectTo}});
        if (failure) throw failure;
        if (current === attempt.current) setNotice('Check your email to confirm your account, then sign in. If you already have an account, use Sign in or Forgot password.');
      } else if (mode === 'reset') {
        const {error: failure} = await client.auth.resetPasswordForEmail(email.trim(), {redirectTo});
        if (failure) throw failure;
        if (current === attempt.current) setNotice('If this address has an account, a password-reset link will arrive by email. Open it in this browser.');
      } else {
        const {error: failure} = await client.auth.updateUser({password});
        if (failure) throw failure;
        if (current === attempt.current) {account.setRecovery(false); setNotice('Your password has been updated.');}
      }
    } catch (failure) {
      if (current === attempt.current) setError(failure instanceof Error ? failure.message : 'The account request could not be completed.');
    } finally {
      if (current === attempt.current) {setPending(false); setPassword('');}
    }
  }
  async function oauth(provider: 'google' | 'github') {
    if (!account.client || pending) return;
    const current = ++attempt.current;
    setPending(true); setError(''); setNotice('');
    try {
      const {error: failure} = await account.client.auth.signInWithOAuth({provider, options: {redirectTo: new URL('/', location.origin).href}});
      if (failure) throw failure;
    } catch (failure) {
      if (current === attempt.current) setError(failure instanceof Error ? failure.message : 'Sign-in could not start. Please try again.');
    } finally {if (current === attempt.current) setPending(false);}
  }
  const title = {signin: 'Your next question starts here.', signup: 'Make room for a question.', reset: 'Reset your password.', password: 'Choose a new password.'}[mode];
  return <dialog className="account-dialog" ref={dialog} aria-labelledby="account-title" onCancel={close} onClick={event => {if (event.target === event.currentTarget) close();}}>
    <div className="dialog-heading"><h2 id="account-title">{title}</h2><button className="icon-button" type="button" aria-label="Close account form" onClick={close}><X size={21}/></button></div>
    <p>{mode === 'signup' ? 'Create an account for temporary conversations.' : mode === 'reset' ? 'We’ll send a link to the email address on your account.' : mode === 'password' ? 'Use a unique password with at least 12 characters.' : 'Sign in or create an account with a provider below.'}</p>
    {(mode==='signin'||mode==='signup')&&<section className="signup-privacy" aria-labelledby="signup-privacy-title"><h3 id="signup-privacy-title">Your account stays. Chats don’t.</h3><p>Your provider shares sign-in and profile details. Messages are processed to answer you, without a saved chat history. Infrastructure providers may keep operational records.</p><details><summary>Read the Privacy Policy</summary><PrivacyContent/><a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer">Open Privacy Policy in a new tab ↗</a></details><p className="muted">Signing in does not subscribe you to marketing or a paid plan.</p></section>}
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
      {mode !== 'password' && <div className="account-links">{mode !== 'signin' && <button type="button" onClick={() => choose('signin')} disabled={pending}>Sign in</button>}{mode !== 'signup' && <button type="button" onClick={() => choose('signup')} disabled={pending}>Create account</button>}{mode === 'signin' && <button type="button" onClick={() => choose('reset')} disabled={pending}>Forgot password?</button>}</div>}
    </form>}</>}
    <p className="muted">Your account is saved. Chats clear when you leave or reload.</p>
  </dialog>;
}
