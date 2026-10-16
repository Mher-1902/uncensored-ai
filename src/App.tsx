import { lazy, Suspense, startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { ArrowUp, Check, Copy, Info, RotateCcw, Square, X, ArrowUpRight } from 'lucide-react';
const Reply=lazy(()=>import('./Reply'));
import {loadConfig,checkModel,reply,type Message,type SiteConfig} from './api';
import {AccountDialog,useAccount} from './account';

function CopyReply({text}:{text:string}){
  const [label,setLabel]=useState('Copy reply');
  useEffect(()=>{if(label==='Copy reply')return;const t=setTimeout(()=>setLabel('Copy reply'),1800);return()=>clearTimeout(t)},[label]);
  return <button className="copy" onClick={()=>navigator.clipboard.writeText(text).then(()=>setLabel('Copied')).catch(()=>setLabel('Copy unavailable'))}>{label==='Copied'?<Check size={14}/>:<Copy size={14}/>} {label}</button>;
}
export function App(){
  const [config,setConfig]=useState<SiteConfig|null>(null),[configError,setConfigError]=useState('');
  const [messages,setMessages]=useState<Message[]>([]),[draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState(''),[length,setLength]=useState(512),[info,setInfo]=useState(false),[reasoned,setReasoned]=useState(false),[ready,setReady]=useState(false);
  const [accountOpen,setAccountOpen]=useState(false),[signingOut,setSigningOut]=useState(false);
  const account=useAccount(config?.auth);
  useEffect(()=>{if(account.recovery)setAccountOpen(true)},[account.recovery]);
  const input=useRef<HTMLTextAreaElement>(null),modal=useRef<HTMLDialogElement>(null),controller=useRef<AbortController|null>(null),scroller=useRef<HTMLDivElement>(null),follow=useRef(true),generation=useRef(0);
  useEffect(()=>{let disposed=false;loadConfig().then(async c=>{if(disposed)return;setConfig(c);const online=await checkModel(c);if(!disposed)setReady(online)}).catch(e=>{if(!disposed)setConfigError(e.message)});return()=>{disposed=true}},[]);
  useEffect(()=>{if(!info||!config?.apiBase)return;let disposed=false;void checkModel(config).then(value=>{if(!disposed)setReady(value)});return()=>{disposed=true}},[info,config]);
  const erase=useEffectEvent(()=>{generation.current++;controller.current?.abort();controller.current=null;setMessages([]);setDraft('');setError('');setBusy(false);setStatus('')});
  useEffect(()=>{if(config?.requireAuth&&!account.loading&&!account.session)erase()},[config?.requireAuth,account.loading,account.session]);
  useEffect(()=>{const leave=()=>erase();const restore=(event:PageTransitionEvent)=>{if(event.persisted)erase()};window.addEventListener('pagehide',leave);window.addEventListener('pageshow',restore);return()=>{window.removeEventListener('pagehide',leave);window.removeEventListener('pageshow',restore);controller.current?.abort()}},[]);
  useEffect(()=>{if(info)modal.current?.showModal();else modal.current?.close()},[info]);
  useEffect(()=>{if(input.current){input.current.style.height='auto';input.current.style.height=`${Math.min(input.current.scrollHeight,180)}px`}},[draft]);
  useEffect(()=>{if(follow.current&&scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight},[messages,status]);
  function clear(){generation.current++;controller.current?.abort();controller.current=null;setMessages([]);setDraft('');setError('');setBusy(false);setStatus('');input.current?.focus()}
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();clear()}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[]);
  async function send(e?:React.FormEvent){
    e?.preventDefault();const question=draft.trim();if(!question||busy)return;
    if(!config||(!config.space&&!config.apiBase)){setError('The website is live. Its model server is not connected yet. No message was sent.');return}
    if(config.requireAuth&&!account.session){setInfo(false);setAccountOpen(true);return}
    const current=++generation.current,ctrl=new AbortController();controller.current=ctrl;setBusy(true);setError('');setDraft('');setStatus('Preparing a reply…');follow.current=true;
    const outgoing=[...messages.filter(m=>m.complete),{id:crypto.randomUUID(),role:'user' as const,content:question,complete:true}];
    const answer:Message={id:crypto.randomUUID(),role:'assistant',content:'',complete:false};
    setMessages([...outgoing,answer]);let finalText='',frame=0;
    const flush=()=>{frame=0;if(current===generation.current)startTransition(()=>setMessages(m=>m.map(x=>x.id===answer.id?{...x,content:finalText}:x)))};
    try{
      const accessToken=config.requireAuth?await account.accessToken():null;
      const result=await reply(config,outgoing,length,reasoned,ctrl.signal,text=>{if(current!==generation.current)return;finalText=text;if(!frame)frame=requestAnimationFrame(flush)},text=>{if(current===generation.current){setStatus(text)}},accessToken);
      if(current===generation.current){if(finalText)setMessages(m=>m.map(x=>x.id===answer.id?{...x,content:finalText,complete:true,limited:result.limited}:x));else{setMessages(m=>m.filter(x=>x.id!==answer.id&&x.id!==outgoing.at(-1)?.id));setDraft(question)}}
    }catch(e){if(current===generation.current&&!ctrl.signal.aborted){setError((e as Error).message);setMessages(m=>m.filter(x=>x.id!==answer.id&&x.id!==outgoing.at(-1)?.id));setDraft(question)}}
    finally{cancelAnimationFrame(frame);if(current===generation.current){if(ctrl.signal.aborted){if(finalText)setMessages(m=>m.map(x=>x.id===answer.id?{...x,content:finalText,complete:true}:x));else{setMessages(m=>m.filter(x=>x.id!==answer.id&&x.id!==outgoing.at(-1)?.id));setDraft(question)}}setBusy(false);setStatus('');controller.current=null;input.current?.focus()}}
  }
  function stop(){controller.current?.abort();setStatus('Stopping…')}
  async function signOut(){if(!account.client||signingOut)return;clear();setSigningOut(true);try{const {error:failure}=await account.client.auth.signOut({scope:'local'});if(failure)throw failure}catch{setError('Sign-out could not complete. Please try again.')}finally{setSigningOut(false)}}
  const active=messages.length>0;
  return <div className={`shell ${active?'in-chat':''}`}>
    <a className="skip-link" href="#composer">Skip to message</a>
    <header className="topbar"><a className="wordmark" href="/" aria-label="Offscript home">offscript<span>_</span></a><div className="header-actions">{config?.requireAuth&&(account.session?<button className="account-button" onClick={()=>void signOut()} disabled={signingOut}>{signingOut?'Signing out…':'Sign out'}</button>:<button className="account-button" onClick={()=>{setInfo(false);setAccountOpen(true)}}>Sign in</button>)}<span className="ephemeral"><span/> TEMPORARY BY DESIGN</span><button className="icon-button" onClick={()=>setInfo(true)} aria-label="About Offscript"><Info size={19}/></button>{active&&<button className="reset" onClick={clear}><RotateCcw size={15}/><span>Clear chat</span></button>}</div></header>
    <main>
      {!active?<section className="hero" aria-labelledby="brand"><img className="hero-mark" src="/favicon.svg" width="48" height="48" alt=""/><div className="hero-copy"><p className="eyebrow">A CONVERSATION. NOT A RECORD.</p><h1 id="brand">offscript<span>_</span></h1><h2>Ask. Think. Disappear.</h2><p className="intro">Your question. A little space to think. No saved chats.</p></div></section>:<div className="conversation" ref={scroller} onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100}}><div className="messages">{messages.map(m=><article className={`message ${m.role}`} key={m.id}><div className="speaker">{m.role==='user'?'YOU':'OFFSCRIPT'}{m.role==='assistant'&&<span className="tiny-mark">_</span>}</div><div className="markdown">{m.content?<Suspense fallback={<p className="plain-reply">{m.content}</p>}><Reply text={m.content}/></Suspense>:<div className="thinking" aria-hidden="true"><span/><span/><span/></div>}</div>{m.role==='assistant'&&m.limited&&<p className="reply-limit" role="status">Reached the reply length limit. Ask “continue” for more.</p>}{m.role==='assistant'&&m.content&&!busy&&<CopyReply text={m.content}/>}</article>)}</div></div>}
      <div className="composer-zone">
        {(error||configError)&&<div className="error" role="alert"><span>{error||configError}</span><button className="icon-button" aria-label="Dismiss error" onClick={()=>{setError('');setConfigError('')}}><X size={16}/></button></div>}
        <form className="composer" onSubmit={send}><label className="sr-only" htmlFor="composer">Message Offscript</label><textarea id="composer" ref={input} placeholder="What's on your mind?" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send()}}} rows={2} autoComplete="off" spellCheck={false}/><div className="composer-bottom"><div className="send-options"><select aria-label="Answer mode" title="Fast replies directly. Deep Think uses a larger thinking budget and takes longer. Neither mode searches the web." value={reasoned?'reasoned':'direct'} onChange={e=>setReasoned(e.target.value==='reasoned')} disabled={Boolean(config?.space&&!config.apiBase)}><option value="direct">Fast</option><option value="reasoned">Deep Think</option></select><select aria-label="Reply length" value={length} onChange={e=>setLength(Number(e.target.value))}><option value={256}>Brief</option><option value={512}>Balanced</option><option value={1024}>Detailed</option></select>{busy?<button type="button" className="send" onClick={stop} aria-label="Stop response"><Square size={18} fill="currentColor"/></button>:<button className="send" disabled={!draft.trim()} aria-label="Send message"><ArrowUp size={22}/></button>}</div></div></form>
        <div className="under-composer"><span>Close or reload this page to clear your chat.</span><span className="keyboard">↵ send <b>·</b> ⇧ ↵ new line</span></div>
      </div>
    </main>
    {!active&&<footer><span>LEAVE NO CHAT BEHIND.</span><button onClick={()=>setInfo(true)}>How it works <ArrowUpRight size={14}/></button></footer>}
    <div className="sr-only" aria-live="polite">{busy?status:error||'Ready for a question.'}</div>
    <dialog ref={modal} aria-labelledby="about-title" onCancel={()=>setInfo(false)} onClick={e=>{if(e.target===e.currentTarget)setInfo(false)}}><div className="dialog-heading"><h2 id="about-title">Here for the moment.</h2><button className="icon-button" aria-label="Close information" onClick={()=>setInfo(false)}><X size={21}/></button></div><p>Offscript keeps this conversation in the current page’s memory. There’s no chat database or archive. Clearing, reloading, or leaving this page clears the conversation.</p>{config?.requireAuth&&<p>Supabase manages account details. This tab keeps your sign-in session; chat messages are never put in browser storage. Signing out also clears this conversation.</p>}<p>Messages are sent to the connected model server to generate a reply. Hosting providers handle network traffic under their own policies; this is not a guarantee of anonymity or zero provider logs.</p><dl><div><dt>Model</dt><dd><a href={config?.modelUrl||'https://huggingface.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive'} target="_blank" rel="noreferrer">{config?.model||'HauhauCS Qwen3.5 2B · Aggressive'}</a></dd></div><div><dt>Model server</dt><dd>{ready?'Online':'Not connected yet'}</dd></div></dl><p className="muted">Fast replies directly. Deep Think uses a larger thinking budget and takes longer. Requests may queue when the server is busy. Answers can be wrong. Neither mode searches the web.</p><button className="dialog-done" onClick={()=>setInfo(false)}>Back to the conversation <ArrowUpRight size={16}/></button></dialog>
    <AccountDialog account={account} open={accountOpen} onClose={()=>setAccountOpen(false)}/>
  </div>;
}
