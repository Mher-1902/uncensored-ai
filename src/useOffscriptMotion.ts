import {useEffect} from 'react';
import './trig.css';

/** Restrict scroll-driven motion to the welcome view; never animate streamed text. */
export function useOffscriptMotion(welcome:boolean){
  useEffect(()=>{
    if(!welcome)return;
    const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed=false,revision=0,cleanup=()=>{};
    async function start(){
      const current=++revision;
      cleanup();
      if(preference.matches)return;
      const {default:Trig}=await import('./vendor/trig.js');
      if(disposed||current!==revision||preference.matches)return;
      const trig=new Trig();
      // Upstream trigInit replaces its constructor observer before watching elements.
      trig.observer.disconnect();
      trig.trigInit();
      const scroll=()=>{if(!document.hidden)trig.trigScroll()};
      const resize=()=>{trig.trigWindowHeight();scroll()};
      window.addEventListener('scroll',scroll,{passive:true});
      window.addEventListener('resize',resize,{passive:true});
      cleanup=()=>{
        window.removeEventListener('scroll',scroll);
        window.removeEventListener('resize',resize);
        trig.observer.disconnect();
      };
    }
    const change=()=>{void start().catch(()=>{})};
    change();
    preference.addEventListener('change',change);
    return()=>{disposed=true;revision++;cleanup();preference.removeEventListener('change',change)};
  },[welcome]);
}
