// One browser-scoped display timestamp, written only after Got it. This is not
// an identity, legal acceptance or permission for tracking. Never enumerate or
// clear account storage. Expiry is checked without refreshing the timestamp.
export const STORAGE_NOTICE_KEY='offscript.storage-notice.2026-10-21';
export const STORAGE_NOTICE_TTL_MS=180*24*60*60*1000;
const validTime=(value:number)=>Number.isSafeInteger(value)&&value>0;
export function noticeDismissed(storage?:Pick<Storage,'getItem'>,now=Date.now()){
  try{
    if(!validTime(now))return false;
    const raw=storage?.getItem(STORAGE_NOTICE_KEY);
    if(typeof raw!=='string'||!/^[1-9]\d{0,15}$/.test(raw))return false;
    const dismissedAt=Number(raw);
    return validTime(dismissedAt)&&dismissedAt<=now&&now-dismissedAt<STORAGE_NOTICE_TTL_MS;
  }catch{return false}
}
export function dismissNotice(storage?:Pick<Storage,'setItem'>,now=Date.now()){
  if(!validTime(now))return;
  try{storage?.setItem(STORAGE_NOTICE_KEY,String(now))}catch{/* Dismiss for this page even if storage is blocked. */}
}
