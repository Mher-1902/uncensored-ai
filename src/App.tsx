import { lazy, Suspense, startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { ArrowUp, Check, Copy, RotateCcw, Square, X } from 'lucide-react';
const Reply=lazy(()=>import('./Reply'));
import {loadConfig,reply,type Message,type SiteConfig} from './api';
import {AccountDialog,useAccount} from './account';
import {PilotDialog,usePilotControls} from './pilot-controls';
import {canUsePilot} from './pilot-api';
import {completedHistory,restoreQuestion,retryTurn,settleAnswer} from './conversation';
import {AnswerMode} from './AnswerMode';
import {HeroArt} from './HeroArt';
import {WelcomeDialog} from './Welcome';
import {PRIVACY_PATH} from './Privacy';
import {CookieNotice,CookieDialog} from './CookieNotice';

function CopyReply({text}:{text:string}){
  const [label,setLabel]=useState('Copy reply');
  useEffect(()=>{if(label==='Copy reply')return;const t=setTimeout(()=>setLabel('Copy reply'),1800);return()=>clearTimeout(t)},[label]);
  return <button className="copy" onClick={()=>navigator.clipboard.writeText(text).then(()=>setLabel('Copied')).catch(()=>setLabel('Copy unavailable'))}>{label==='Copied'?<Check size={14}/>:<Copy size={14}/>} {label}</button>;
}
function WaitingReply(){
  const [slow,setSlow]=useState(false);
  useEffect(()=>{const timer=setTimeout(()=>setSlow(true),12000);return()=>clearTimeout(timer)},[]);
  return <><div className="thinking" aria-hidden="true"><span/><span/><span/></div>{slow&&<p className="reply-wait" role="status">Still working. You can stop this reply.</p>}</>;
}
export function App(){
  const [config,setConfig]=useState<SiteConfig|null>(null),[configError,setConfigError]=useState('');
  const [messages,setMessages]=useState<Message[]>([]),[draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState(''),[reasoned,setReasoned]=useState(false);
  const [pilotOpen,setPilotOpen]=useState(false),[accountOpen,setAccountOpen]=useState(false),[signingOut,setSigningOut]=useState(false);
  const [cookiesOpen,setCookiesOpen]=useState(false);
  const account=useAccount(config?.auth);
  const pilot=usePilotControls(config,account.session?.user.id,account.accessToken);
  useEffect(()=>{if(!account.session)setPilotOpen(false)},[account.session?.user.id]);
  useEffect(()=>{if(account.recovery)setAccountOpen(true)},[account.recovery]);
  const input=useRef<HTMLTextAreaElement>(null),controller=useRef<AbortController|null>(null),scroller=useRef<HTMLDivElement>(null),follow=useRef(true),generation=useRef(0);
  useEffect(()=>{let disposed=false;loadConfig().then(c=>{if(!disposed)setConfig(c)}).catch(e=>{if(!disposed)setConfigError(e.message)});return()=>{disposed=true}},[]);
  const erase=useEffectEvent(()=>{generation.current++;controller.current?.abort();controller.current=null;setMessages([]);setDraft('');setError('');setBusy(false);setStatus('')});
  useEffect(()=>{if(config?.requireAuth&&!account.loading&&!account.session)erase()},[config?.requireAuth,account.loading,account.session]);
  useEffect(()=>{const leave=()=>erase();const restore=(event:PageTransitionEvent)=>{if(event.persisted)erase()};window.addEventListener('pagehide',leave);window.addEventListener('pageshow',restore);return()=>{window.removeEventListener('pagehide',leave);window.removeEventListener('pageshow',restore);controller.current?.abort()}},[]);
  useEffect(()=>{if(input.current){input.current.style.height='auto';input.current.style.height=`${Math.min(input.current.scrollHeight,180)}px`}},[draft]);
  useEffect(()=>{if(follow.current&&scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight},[messages,status]);
  function clear(){generation.current++;controller.current?.abort();controller.current=null;setMessages([]);setDraft('');setError('');setBusy(false);setStatus('');input.current?.focus()}
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();clear()}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[]);
  async function send(e?:React.FormEvent){
    e?.preventDefault();await beginReply(draft.trim(),reasoned);
  }
  async function retry(id:string){
    const turn=retryTurn(messages,id);if(turn)await beginReply(turn.question.content,Boolean(turn.answer.reasoned),turn);
  }
  async function beginReply(question:string,deep:boolean,retry?:NonNullable<ReturnType<typeof retryTurn>>){
    if(!question||busy)return;
    if(!config||(!config.space&&!config.apiBase)){setError('The website is live. Its model server is not connected yet. No message was sent.');return}
    if(config.requireAuth&&!account.session){setAccountOpen(true);return}
    if(config.accountControl&&(pilot.loading||pilot.error||!canUsePilot(pilot.data,deep))){setPilotOpen(true);return}
    const current=++generation.current,ctrl=new AbortController();controller.current=ctrl;setBusy(true);setError('');setDraft(value=>value.trim()===question?'':value);setStatus('Preparing a reply…');follow.current=true;
    const user:Message=retry?.question||{id:crypto.randomUUID(),role:'user',content:question,complete:true};
    const outgoing=[...(retry?.history||completedHistory(messages)),user];
    const answer:Message={id:crypto.randomUUID(),role:'assistant',content:'',complete:false,state:'streaming',questionId:user.id,reasoned:deep};
    setMessages(retry?[...messages.slice(0,-1),answer]:[...messages,user,answer]);let finalText='',frame=0;
    const flush=()=>{frame=0;if(current===generation.current)startTransition(()=>setMessages(m=>m.map(x=>x.id===answer.id?{...x,content:finalText}:x)))};
    try{
      const accessToken=config.requireAuth?await account.accessToken():null;
      await reply(config,outgoing,deep,ctrl.signal,text=>{if(current!==generation.current)return;finalText=text;if(!frame)frame=requestAnimationFrame(flush)},text=>{if(current===generation.current){setStatus(text)}},accessToken);
      if(!finalText.trim())throw Error('No answer was received. Please try again.');
      if(current===generation.current)setMessages(m=>settleAnswer(m,answer.id,finalText,'complete'));
    }catch(e){if(current===generation.current&&!ctrl.signal.aborted){setError((e as Error).message);setMessages(m=>settleAnswer(m,answer.id,finalText,'interrupted'));if(!finalText)setDraft(value=>restoreQuestion(value,question))}}
    finally{cancelAnimationFrame(frame);if(current===generation.current){if(ctrl.signal.aborted){setMessages(m=>settleAnswer(m,answer.id,finalText,'stopped'));if(!finalText)setDraft(value=>restoreQuestion(value,question))}setBusy(false);setStatus('');controller.current=null;input.current?.focus();if(config.accountControl)void pilot.refresh()}}
  }
  function stop(event:React.MouseEvent<HTMLButtonElement>){event.preventDefault();controller.current?.abort();setStatus('Stopping…')}
  async function signOut(){if(!account.client||signingOut)return;clear();setSigningOut(true);try{const {error:failure}=await account.client.auth.signOut({scope:'local'});if(failure)throw failure}catch{setError('Sign-out could not complete. Please try again.')}finally{setSigningOut(false)}}
  const active=messages.length>0;
  return <div className={`shell ${active?'in-chat':''}`}>
    <a className="skip-link" href="#composer">Skip to message</a>
    <header className="topbar"><a className="wordmark" href="/" aria-label="Offscript home">offscript<span>_</span></a><div className="header-actions">{config?.requireAuth&&(account.session?(config.accountControl?<button className="account-button" onClick={()=>setPilotOpen(true)}>Account</button>:<button className="account-button" onClick={()=>void signOut()} disabled={signingOut}>{signingOut?'Signing out…':'Sign out'}</button>):<button className="account-button" onClick={()=>{setAccountOpen(true)}}>Sign in</button>)}<span className="ephemeral"><span/> TEMPORARY BY DESIGN</span>{active&&<button className="reset" onClick={clear} aria-label="Clear chat"><RotateCcw size={15}/><span>Clear chat</span></button>}</div></header>
    <main>
      {!active?<section className="hero" aria-labelledby="brand"><HeroArt/><div className="hero-copy"><h1 id="brand">offscript<span>_</span></h1><h2>Ask. Think. Disappear.</h2><p className="intro">Your question. A little space to think. No saved chats.</p></div></section>:<div className="conversation" ref={scroller} onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100}}><div className="messages">{messages.map(m=><article className={`message ${m.role}`} key={m.id}><div className="speaker">{m.role==='user'?'YOU':'OFFSCRIPT'}{m.role==='assistant'&&<span className="tiny-mark">_</span>}</div><div className="markdown">{m.content?<Suspense fallback={<p className="plain-reply">{m.content}</p>}><Reply text={m.content}/></Suspense>:m.state==='streaming'?<WaitingReply/>:null}</div>{m.role==='assistant'&&m.state!=='streaming'&&<div className="reply-actions">{(m.state==='stopped'||m.state==='interrupted')&&<span className="reply-outcome">{m.state==='stopped'?'Stopped':m.content?'Reply interrupted':'No answer received'}</span>}{!busy&&retryTurn(messages,m.id)&&<button className="retry-reply" onClick={()=>void retry(m.id)}><RotateCcw size={13}/>Retry answer</button>}{m.content&&<CopyReply text={m.content}/>}</div>}</article>)}</div></div>}
      <div className="composer-zone">
        {(error||configError)&&<div className="error" role="alert"><span>{error||configError}</span><button className="icon-button" aria-label="Dismiss error" onClick={()=>{setError('');setConfigError('')}}><X size={16}/></button></div>}
        <form className="composer" onSubmit={send}>
          <label className="sr-only" htmlFor="composer">Message Offscript</label>
          <textarea id="composer" ref={input} placeholder="Ask anything. Go off script." value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&!busy){e.preventDefault();void send()}}} rows={1} autoComplete="off" spellCheck={false}/>
          <div className="composer-bottom">
            <div className="send-options">
              <AnswerMode reasoned={reasoned} onChange={setReasoned} disabled={Boolean(config?.space&&!config.apiBase)}/>
            </div>
            {busy?<button key="stop" type="button" className="send" onClick={stop} aria-label="Stop response"><Square size={18} fill="currentColor"/></button>:<button key="send" type="submit" className="send" disabled={!draft.trim()||!config||account.loading} aria-label="Send message"><ArrowUp size={22}/></button>}
          </div>
        </form>
        <div className="under-composer"><span>Close or reload this page to clear your chat.</span><a className="privacy-link" href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer">Privacy</a><button className="privacy-link" type="button" onClick={()=>setCookiesOpen(true)}>Cookies</button><span className="keyboard">↵ send <b>·</b> ⇧ ↵ new line</span></div>
      </div>
    </main>
    <CookieNotice onDetails={()=>setCookiesOpen(true)} onDismiss={()=>input.current?.focus()}/>
    <div className="sr-only" aria-live="polite">{busy?status:error||'Ready for a question.'}</div>
    {config?.accountControl&&account.session&&<PilotDialog controls={pilot} open={pilotOpen} onClose={()=>setPilotOpen(false)} onSignOut={()=>void signOut()} signingOut={signingOut}/>}
    <AccountDialog account={account} open={accountOpen} onClose={()=>setAccountOpen(false)}/>
    <WelcomeDialog open={account.welcome&&!accountOpen&&!pilotOpen&&!cookiesOpen&&!account.recovery} onClose={account.dismissWelcome} onAfterClose={()=>input.current?.focus()}/>
    <CookieDialog open={cookiesOpen} onClose={()=>setCookiesOpen(false)}/>
  </div>;
}
