// One tab-scoped display preference. Never clear or enumerate account storage.
export const STORAGE_NOTICE_KEY='offscript.storage-notice.2026-10-20';
export function noticeDismissed(storage?:Pick<Storage,'getItem'>){
  try{return storage?.getItem(STORAGE_NOTICE_KEY)==='dismissed'}catch{return false}
}
export function dismissNotice(storage?:Pick<Storage,'setItem'>){
  try{storage?.setItem(STORAGE_NOTICE_KEY,'dismissed')}catch{/* Dismiss for this page even if storage is blocked. */}
}
