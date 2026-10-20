import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {CookiesContent,COOKIES_PATH} from './Cookies';
import {noticeDismissed,dismissNotice} from './storage-notice';

function tabStorage(){try{return window.sessionStorage}catch{return undefined}}
export function CookieNotice({onDetails,onDismiss}:{onDetails:()=>void;onDismiss:()=>void}){
  const [visible,setVisible]=useState(false);
  useEffect(()=>setVisible(!noticeDismissed(tabStorage())),[]);
  if(!visible)return null;
  function dismiss(){dismissNotice(tabStorage());setVisible(false);onDismiss()}
  return <aside className="storage-notice" aria-labelledby="storage-notice-title">
    <div><h2 id="storage-notice-title">Just the essentials.</h2><p>We use browser storage for sign-in and this notice. No analytics or advertising tags.</p><button className="notice-details" type="button" onClick={onDetails}>Cookies &amp; storage details</button></div>
    <button type="button" className="notice-dismiss" onClick={dismiss}>Got it</button>
  </aside>;
}

export function CookieDialog({open,onClose}:{open:boolean;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close()},[open]);
  return <dialog className="cookie-dialog" ref={dialog} aria-labelledby="cookie-dialog-title" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
    <div className="dialog-heading"><h2 id="cookie-dialog-title">Cookies &amp; browser storage</h2><button className="icon-button" type="button" aria-label="Close cookie details" onClick={onClose}><X size={21}/></button></div>
    <CookiesContent/>
    <p><a href={COOKIES_PATH} target="_blank" rel="noopener noreferrer">Open the full notice in a new tab ↗</a></p>
    <button className="dialog-done" type="button" onClick={onClose}>Back to Offscript <span aria-hidden="true">↗</span></button>
  </dialog>;
}
