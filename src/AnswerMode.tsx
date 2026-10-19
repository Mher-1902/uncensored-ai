import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import {Check,ChevronDown} from 'lucide-react';

const modes=['Fast','Deep Think'] as const;

export function AnswerMode({reasoned,onChange,disabled=false}:{reasoned:boolean;onChange:(value:boolean)=>void;disabled?:boolean}){
  const [open,setOpen]=useState(false),[active,setActive]=useState(reasoned?1:0);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),listId=useId();
  const selected=reasoned?1:0;
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false)};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  useEffect(()=>{if(disabled)setOpen(false)},[disabled]);
  function choose(index:number){onChange(index===1);setOpen(false);trigger.current?.focus({preventScroll:true})}
  function keyDown(event:KeyboardEvent<HTMLButtonElement>){
    if(event.key==='Tab'){setOpen(false);return}
    if(event.key==='Escape'&&open){event.preventDefault();setOpen(false);return}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();setActive(open?(active+(event.key==='ArrowDown'?1:-1)+modes.length)%modes.length:selected);setOpen(true);return;
    }
    if(event.key==='Home'||event.key==='End'){event.preventDefault();setActive(event.key==='Home'?0:modes.length-1);setOpen(true);return}
    if(open&&(event.key==='Enter'||event.key===' ')){event.preventDefault();choose(active);return}
    if(open&&/^[fd]$/i.test(event.key)){event.preventDefault();setActive(event.key.toLowerCase()==='f'?0:1)}
  }
  return <div className="mode-picker" ref={root} data-open={open} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false)}}>
    <button ref={trigger} type="button" className="mode-trigger" role="combobox" aria-label="Answer mode" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open?listId:undefined} aria-activedescendant={open?`${listId}-${active}`:undefined} disabled={disabled}
      onKeyDown={keyDown} onClick={()=>{setActive(selected);setOpen(!open)}}>
      <span>{modes[selected]}</span><ChevronDown size={13} aria-hidden="true"/>
    </button>
    {open&&<ul className="mode-menu" role="listbox" aria-label="Answer mode" id={listId}>
      {modes.map((mode,index)=><li key={mode} id={`${listId}-${index}`} role="option" aria-selected={selected===index} data-active={active===index}
        onPointerEnter={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}>
        <span>{mode}</span><span className="mode-check" aria-hidden="true">{selected===index&&<Check size={14}/>}</span>
      </li>)}
    </ul>}
  </div>;
}
