import {useEffect,useRef} from 'react';
import {X} from 'lucide-react';
import {PRIVACY_PATH} from './Privacy';

export function WelcomeDialog({open,onClose,onAfterClose}:{open:boolean;onClose:()=>void;onAfterClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close()},[open]);
  return <dialog className="welcome-dialog" ref={dialog} aria-labelledby="welcome-title" onClose={onAfterClose} onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget)onClose()}}>
    <div className="dialog-heading"><h2 id="welcome-title">You’re in.</h2><button type="button" className="icon-button" aria-label="Close welcome" onClick={onClose}><X size={21}/></button></div>
    <p className="welcome-lead">Welcome to offscript<span>_</span></p>
    <p>A little space for your next question. Your account stays; your conversations don’t.</p>
    <ul><li><strong>Fast</strong> replies directly. <strong>Deep Think</strong> takes more time to reason.</li><li>Chats live in this tab. Copy anything you need before leaving or reloading.</li><li>AI can be wrong. Check important answers before relying on them.</li></ul>
    <p><a href={PRIVACY_PATH} target="_blank" rel="noopener noreferrer">Privacy Policy</a></p>
    <button type="button" className="dialog-done" onClick={onClose}>Start a conversation <span aria-hidden="true">↗</span></button>
  </dialog>;
}
