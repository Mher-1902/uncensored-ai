import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ArrowUp, Check, Copy, Info, RotateCcw, Square, X, ArrowUpRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {loadConfig,reply,type Message,type SiteConfig} from './api';

function CopyReply({text}:{text:string}){
  const [label,setLabel]=useState('Copy reply');
  useEffect(()=>{if(label==='Copy reply')return;const t=setTimeout(()=>setLabel('Copy reply'),1800);return()=>clearTimeout(t)},[label]);
  return <button className="copy" onClick={()=>navigator.clipboard.writeText(text).then(()=>setLabel('Copied')).catch(()=>setLabel('Copy unavailable'))}>{label==='Copied'?<Check size={14}/>:<Copy size={14}/>} {label}</button>;
}
export function App(){
  const [config,setConfig]=useState<SiteConfig|null>(null),[configError,setConfigError]=useState('');
  const [messages,setMessages]=useState<Message[]>([]),[draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState(''),[length,setLength]=useState(512),[info,setInfo]=useState(false);
  const input=useRef<HTMLTextAreaElement>(null),modal=useRef<HTMLDialogElement>(null),controller=useRef<AbortController|null>(null),scroller=useRef<HTMLDivElement>(null),follow=useRef(true),generation=useRef(0);
  useEffect(()=>{let disposed=false;loadConfig().then(c=>{if(!disposed)setConfig(c)}).catch(e=>{if(!disposed)setConfigError(e.message)});return()=>{disposed=true}},[]);
  const erase=useEffectEvent(()=>{generation.current++;controller.current?.abort();controller.current=null;setMessages([]);setDraft('');setError('');setBusy(false);setStatus('')});
  useEffect(()=>{const leave=()=>erase();const restore=(event:PageTransitionEvent)=>{if(event.persisted)erase()};window.addEventListener('pagehide',leave);window.addEventListener('pageshow',restore);return()=>{window.removeEventListener('pagehide',leave);window.removeEventListener('pageshow',restore);controller.current?.abort()}},[]);
  useEffect(()=>{if(info)modal.current?.showModal();else modal.current?.close()},[info]);
  useEffect(()=>{if(input.current){input.current.style.height='auto';input.current.style.height=`${Math.min(input.current.scrollHeight,180)}px`}},[draft]);
  useEffect(()=>{if(follow.current&&scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight},[messages,status]);
  function clear(){generation.current++;controller.current?.abort();controller.current=null;setMessages([]);setDraft('');setError('');setBusy(false);setStatus('');input.current?.focus()}
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();clear()}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[]);
  async function send(e?:React.FormEvent){
    e?.preventDefault();const question=draft.trim();if(!question||busy)return;
    if(!config?.space){setError('The website is live, but its cloud model has not been connected yet. No message was sent.');return}
    const current=++generation.current,ctrl=new AbortController();controller.current=ctrl;setBusy(true);setError('');setDraft('');setStatus('Connecting to the cloud model…');follow.current=true;
    const outgoing=[...messages.filter(m=>m.complete),{id:crypto.randomUUID(),role:'user' as const,content:question,complete:true}];
    const answer:Message={id:crypto.randomUUID(),role:'assistant',content:'',complete:false};
    setMessages([...outgoing,answer]);let finalText='';
    try{
      await reply(config.space,outgoing,length,ctrl.signal,text=>{if(current!==generation.current)return;finalText=text;setMessages(m=>m.map(x=>x.id===answer.id?{...x,content:text}:x))},text=>{if(current===generation.current)setStatus(text)});
      if(current===generation.current){if(finalText)setMessages(m=>m.map(x=>x.id===answer.id?{...x,complete:true}:x));else{setMessages(m=>m.filter(x=>x.id!==answer.id&&x.id!==outgoing.at(-1)?.id));setDraft(question)}}
    }catch(e){if(current===generation.current&&!ctrl.signal.aborted){setError((e as Error).message);setMessages(m=>m.filter(x=>x.id!==answer.id&&x.id!==outgoing.at(-1)?.id));setDraft(question)}}
    finally{if(current===generation.current){setBusy(false);setStatus('');controller.current=null;input.current?.focus()}}
  }
  function stop(){controller.current?.abort();setStatus('Stopping…')}
  const active=messages.length>0;
  return <div className={`shell ${active?'in-chat':''}`}>
    <a className="skip-link" href="#composer">Skip to message</a>
    <header className="topbar"><a className="wordmark" href="/" aria-label="Offscript home">offscript<span>_</span></a><div className="header-actions"><span className="ephemeral"><span/> TEMPORARY BY DESIGN</span><button className="icon-button" onClick={()=>setInfo(true)} aria-label="About Offscript"><Info size={19}/></button>{active&&<button className="reset" onClick={clear}><RotateCcw size={15}/><span>Clear chat</span></button>}</div></header>
    <main>
      {!active?<section className="hero" aria-labelledby="brand"><div className="hero-art" role="img" aria-label="Anonymous figure wearing a hat and sunglasses, working at a laptop"/><div className="hero-copy"><p className="eyebrow">A CONVERSATION. NOT A RECORD.</p><h1 id="brand">offscript<span>_</span></h1><h2>Ask. Think. Disappear.</h2><p className="intro">No account. No saved chats. Just you and the question.</p></div></section>:<div className="conversation" ref={scroller} onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100}}><div className="messages">{messages.map(m=><article className={`message ${m.role}`} key={m.id}><div className="speaker">{m.role==='user'?'YOU':'OFFSCRIPT'}{m.role==='assistant'&&<span className="tiny-mark">_</span>}</div><div className="markdown">{m.content?<ReactMarkdown remarkPlugins={[remarkGfm]} components={{a:({children,...p})=><a {...p} target="_blank" rel="noopener noreferrer">{children}</a>,img:({alt})=><em>[{alt||'External image omitted'}]</em>}}>{m.content}</ReactMarkdown>:<div className="thinking"><span/><span/><span/><p>{status||'Waiting for a reply…'}</p></div>}</div>{m.role==='assistant'&&m.content&&!busy&&<CopyReply text={m.content}/>}</article>)}{busy&&messages.at(-1)?.content&&<p className="stream-status" role="status">{status}</p>}</div></div>}
      <div className="composer-zone">
        {(error||configError)&&<div className="error" role="alert"><span>{error||configError}</span><button className="icon-button" aria-label="Dismiss error" onClick={()=>{setError('');setConfigError('')}}><X size={16}/></button></div>}
        <form className="composer" onSubmit={send}><label className="sr-only" htmlFor="composer">Message Offscript</label><textarea id="composer" ref={input} placeholder="What's on your mind?" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send()}}} rows={2} autoComplete="off" spellCheck={false}/><div className="composer-bottom"><div className={`connection ${config?.space?'connected':''}`}><span/>{config?.space?'CLOUD MODEL':config?'MODEL NOT CONNECTED':'CONNECTING'}</div><div className="send-options"><select aria-label="Reply length" value={length} onChange={e=>setLength(Number(e.target.value))}><option value={256}>Brief</option><option value={512}>Balanced</option><option value={1024}>Detailed</option></select>{busy?<button type="button" className="send" onClick={stop} aria-label="Stop response"><Square size={18} fill="currentColor"/></button>:<button className="send" disabled={!draft.trim()} aria-label="Send message"><ArrowUp size={22}/></button>}</div></div></form>
        <div className="under-composer"><span>Close or reload this page to clear your chat.</span><span className="keyboard">↵ send <b>·</b> ⇧ ↵ new line</span></div>
      </div>
    </main>
    {!active&&<footer><span>LEAVE NO CHAT BEHIND.</span><button onClick={()=>setInfo(true)}>How it works <ArrowUpRight size={14}/></button></footer>}
    <div className="sr-only" aria-live="polite">{busy?status:error||'Ready for a question.'}</div>
    <dialog ref={modal} aria-labelledby="about-title" onCancel={()=>setInfo(false)} onClick={e=>{if(e.target===e.currentTarget)setInfo(false)}}><div className="dialog-heading"><h2 id="about-title">Here for the moment.</h2><button className="icon-button" aria-label="Close information" onClick={()=>setInfo(false)}><X size={21}/></button></div><p>Offscript keeps this conversation in the current page’s memory. There’s no chat database, browser storage, account, or archive. Clearing, reloading, or leaving this page clears the conversation.</p><p>Messages are sent to the cloud model to generate a reply. Hosting providers handle network traffic under their own policies; this is not a guarantee of anonymity or zero provider logs.</p><dl><div><dt>Model</dt><dd><a href={config?.modelUrl||'https://huggingface.co/huihui-ai/Huihui-Qwen3.5-9B-abliterated'} target="_blank" rel="noreferrer">{config?.model||'Huihui Qwen3.5 9B'}</a></dd></div><div><dt>Cloud connection</dt><dd>{config?.space?'Configured':'Not connected yet'}</dd></div></dl><p className="muted">Free GPU services have usage quotas and may queue requests or sleep. Answers can be wrong. The model has no live web access.</p><button className="dialog-done" onClick={()=>setInfo(false)}>Back to the conversation <ArrowUpRight size={16}/></button></dialog>
  </div>;
}
