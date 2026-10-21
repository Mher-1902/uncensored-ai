import test from 'node:test';
import assert from 'node:assert/strict';
import {STORAGE_NOTICE_KEY,STORAGE_NOTICE_TTL_MS,noticeDismissed,dismissNotice} from '../src/storage-notice.ts';

const NOW=Date.UTC(2026,9,21,12);
const preference=(value)=>({getItem:()=>value});

test('explicit dismissal writes only one timestamp preference and preserves authentication storage',()=>{
  const data=new Map([['sb-fixture-auth-token','private session fixture'],['unrelated','keep']]);
  const accessed=[];
  const storage={getItem(key){accessed.push(['read',key]);return data.get(key)??null},setItem(key,value){accessed.push(['write',key]);data.set(key,value)}};
  assert.equal(noticeDismissed(storage,NOW),false);
  assert.equal(data.has(STORAGE_NOTICE_KEY),false,'A first-visit read must not persist a preference');
  dismissNotice(storage,NOW);
  assert.equal(noticeDismissed(storage,NOW+1),true);
  assert.deepEqual([...new Set(accessed.map(([,key])=>key))],[STORAGE_NOTICE_KEY]);
  assert.deepEqual(accessed.filter(([type])=>type==='write'),[['write',STORAGE_NOTICE_KEY]]);
  assert.deepEqual([...data],[['sb-fixture-auth-token','private session fixture'],['unrelated','keep'],[STORAGE_NOTICE_KEY,String(NOW)]]);
});

test('timestamp preference survives a new storage reader without extending its 180 day lifetime',()=>{
  const data=new Map();
  dismissNotice({setItem:(key,value)=>data.set(key,value)},NOW);
  const newVisit={getItem:key=>data.get(key)??null};
  assert.equal(STORAGE_NOTICE_TTL_MS,180*24*60*60*1000);
  assert.equal(noticeDismissed(newVisit,NOW),true);
  assert.equal(noticeDismissed(newVisit,NOW+STORAGE_NOTICE_TTL_MS-1),true);
  assert.equal(noticeDismissed(newVisit,NOW+STORAGE_NOTICE_TTL_MS),false);
  assert.equal(noticeDismissed(newVisit,NOW+STORAGE_NOTICE_TTL_MS+1),false);
  assert.equal(data.get(STORAGE_NOTICE_KEY),String(NOW),'Reading must not slide the expiry or rewrite data');
});

test('future timestamps and a clock moving behind the recorded dismissal never suppress the notice',()=>{
  assert.equal(noticeDismissed(preference(String(NOW+1)),NOW),false);
  assert.equal(noticeDismissed(preference(String(NOW+STORAGE_NOTICE_TTL_MS)),NOW),false);
  assert.equal(noticeDismissed(preference(String(NOW)),NOW-1),false);
});

test('missing, legacy, malformed and out of range preference values cannot imply dismissal or consent',()=>{
  for(const value of [null,'','dismissed','accepted','rejected','true','0','-1',
    ' '+NOW,NOW+' ','0'+NOW,String(NOW)+'.5','1e12','NaN','Infinity',
    '9007199254740992','[1]','{"accepted":true}',JSON.stringify({dismissedAt:NOW})]){
    assert.equal(noticeDismissed(preference(value),NOW),false,String(value));
  }
  assert.equal(noticeDismissed(preference(String(NOW)),NOW),true);
});

test('invalid current times cannot create preferences or hide a notice',()=>{
  for(const now of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){
    let writes=0;
    dismissNotice({setItem(){writes++;}},now);
    assert.equal(writes,0);
    assert.equal(noticeDismissed(preference(String(NOW)),now),false);
  }
});

test('blocked or unavailable storage leaves dismissal to page state without breaking sign-in UI',()=>{
  const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}};
  assert.equal(noticeDismissed(blocked,NOW),false);
  assert.doesNotThrow(()=>dismissNotice(blocked,NOW));
  assert.equal(noticeDismissed(undefined,NOW),false);
  assert.doesNotThrow(()=>dismissNotice(undefined,NOW));
});

test('expired or unrelated notice-version entries do not enumerate or delete any site storage',()=>{
  const legacyKey='offscript.storage-notice.2026-10-20';
  const data=new Map([[legacyKey,'dismissed'],[STORAGE_NOTICE_KEY,String(NOW-STORAGE_NOTICE_TTL_MS)],['sb-fixture-auth-token','keep']]);
  const before=[...data],accessed=[];
  const storage={getItem(key){accessed.push(key);return data.get(key)??null},
    setItem(){throw Error('Unexpected write')},removeItem(){throw Error('Unexpected deletion')},
    clear(){throw Error('Unexpected origin-wide clear')},key(){throw Error('Unexpected storage enumeration')}};
  assert.equal(noticeDismissed(storage,NOW),false);
  assert.deepEqual(accessed,[STORAGE_NOTICE_KEY]);
  assert.deepEqual([...data],before);
});
