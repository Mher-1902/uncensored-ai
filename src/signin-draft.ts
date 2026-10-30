// A single tab-scoped handoff for an explicit sign-in attempt. Callers provide
// sessionStorage; this module never obtains browser storage or logs draft text.
export const SIGNIN_DRAFT_KEY='offscript.signin-draft.v1';
export const SIGNIN_DRAFT_TTL_MS=10*60*1000;
// JavaScript string length (UTF-16 code units). Reject larger drafts intact.
export const MAX_CHARS=65536;
export const SIGNIN_DRAFT_MAX_CHARS=MAX_CHARS;
export type SignInDraft={
  version:1;
  attemptId:string;
  createdAt:number;
  text:string;
  reasoned:boolean;
  authOrigin:string;
  ownerId:string|null;
};
export type SignInDraftInput=Pick<SignInDraft,'text'|'reasoned'|'authOrigin'|'ownerId'>;
type DraftReader=Pick<Storage,'getItem'|'removeItem'>;
type DraftStorage=DraftReader&Pick<Storage,'setItem'>;
const MAX_ORIGIN_CHARS=2048,MAX_OWNER_CHARS=1024;
// JSON can escape one input code unit into six ASCII characters. Bound the raw
// value before parsing, including bounded identity fields and schema overhead.
const MAX_STORED_CHARS=6*(MAX_CHARS+MAX_ORIGIN_CHARS+MAX_OWNER_CHARS)+1024;
const FIELDS=['version','attemptId','createdAt','text','reasoned','authOrigin','ownerId'];
const validTime=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const validAttempt=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validOwner=(value:unknown):value is string=>typeof value==='string'&&value.length<=MAX_OWNER_CHARS&&value.trim().length>0;
function validOrigin(value:unknown):value is string{
  if(typeof value!=='string'||value.length>MAX_ORIGIN_CHARS)return false;
  try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value;}
  catch{return false;}
}
function validInput(value:SignInDraftInput){
  return typeof value.text==='string'&&value.text.length<=MAX_CHARS&&value.text.trim().length>0&&
    typeof value.reasoned==='boolean'&&validOrigin(value.authOrigin)&&
    (value.ownerId===null||validOwner(value.ownerId));
}

// A stale failure/cancellation may delete only its own attempt. Unscoped clears
// are reserved for explicit Clear/sign-out and invalid or expired handoffs.
export function clearSignInDraft(storage?:DraftReader,attemptId?:string):void{
  try{
    if(!storage)return;
    if(attemptId!==undefined){
      if(!validAttempt(attemptId))return;
      const raw=storage.getItem(SIGNIN_DRAFT_KEY);
      if(typeof raw!=='string'||raw.length>MAX_STORED_CHARS)return;
      const value:unknown=JSON.parse(raw);
      if(!value||typeof value!=='object'||Array.isArray(value)||
        (value as {attemptId?:unknown}).attemptId!==attemptId)return;
    }
    storage.removeItem(SIGNIN_DRAFT_KEY);
  }catch{/* Storage failure must not break sign-in or erase other keys. */}
}

export function saveSignInDraft(storage:DraftStorage|undefined,input:SignInDraftInput,now=Date.now()):string|null{
  let attemptId:string|undefined;
  try{
    if(!storage)return null;
    if(!validTime(now)||!validInput(input)){clearSignInDraft(storage);return null;}
    // A failed new handoff must not leave an older prompt eligible for restore.
    storage.removeItem(SIGNIN_DRAFT_KEY);
    if(storage.getItem(SIGNIN_DRAFT_KEY)!==null)return null;
    attemptId=globalThis.crypto.randomUUID();
    if(!validAttempt(attemptId))return null;
    const draft:SignInDraft={version:1,attemptId,createdAt:now,text:input.text,
      reasoned:input.reasoned,authOrigin:input.authOrigin,ownerId:input.ownerId};
    const raw=JSON.stringify(draft);
    if(raw.length>MAX_STORED_CHARS)return null;
    storage.setItem(SIGNIN_DRAFT_KEY,raw);
    if(storage.getItem(SIGNIN_DRAFT_KEY)!==raw){clearSignInDraft(storage,attemptId);return null;}
    return attemptId;
  }catch{
    if(attemptId!==undefined)clearSignInDraft(storage,attemptId);
    return null;
  }
}

export function readSignInDraft(storage:DraftReader|undefined,authOrigin:string,now=Date.now()):SignInDraft|null{
  try{
    if(!storage)return null;
    if(!validTime(now)||!validOrigin(authOrigin)){clearSignInDraft(storage);return null;}
    const raw=storage.getItem(SIGNIN_DRAFT_KEY);
    if(raw===null)return null;
    let value:unknown;
    if(typeof raw==='string'&&raw.length<=MAX_STORED_CHARS){
      try{value=JSON.parse(raw);}catch{/* Purge malformed values below. */}
    }
    if(value&&typeof value==='object'&&!Array.isArray(value)){
      const draft=value as SignInDraft;
      const keys=Object.keys(value);
      if(keys.length===FIELDS.length&&FIELDS.every(key=>Object.hasOwn(value,key))&&
        draft.version===1&&validAttempt(draft.attemptId)&&validTime(draft.createdAt)&&
        draft.createdAt<=now&&now-draft.createdAt<SIGNIN_DRAFT_TTL_MS&&
        validInput(draft)&&draft.authOrigin===authOrigin)return draft;
    }
    clearSignInDraft(storage);
    return null;
  }catch{return null;}
}

export function consumeSignInDraft(storage:DraftReader|undefined,context:{authOrigin:string;userId:string|null},now=Date.now()):SignInDraft|null{
  try{
    const draft=readSignInDraft(storage,context.authOrigin,now);
    if(!draft||!storage)return null;
    if(context.userId!==null&&!validOwner(context.userId))return null;
    if(draft.ownerId!==null){
      if(context.userId===null)return null; // Wait for the restored auth session.
      if(draft.ownerId!==context.userId){clearSignInDraft(storage,draft.attemptId);return null;}
    }
    // Recheck the attempt before removal; a newer handoff must survive. Return
    // text only after confirmed removal, so blocked/no-op storage cannot replay it.
    const raw=storage.getItem(SIGNIN_DRAFT_KEY);
    if(typeof raw!=='string'||raw.length>MAX_STORED_CHARS)return null;
    const current:unknown=JSON.parse(raw);
    if(!current||typeof current!=='object'||Array.isArray(current)||
      (current as {attemptId?:unknown}).attemptId!==draft.attemptId)return null;
    storage.removeItem(SIGNIN_DRAFT_KEY);
    return storage.getItem(SIGNIN_DRAFT_KEY)===null?draft:null;
  }catch{return null;}
}
