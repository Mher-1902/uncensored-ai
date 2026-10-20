import test from 'node:test';
import assert from 'node:assert/strict';
import {STORAGE_NOTICE_KEY,noticeDismissed,dismissNotice} from '../src/storage-notice.ts';

test('notice display state cannot consume or overwrite authentication storage',()=>{
  const data=new Map([['sb-fixture-auth-token','private session fixture'],['unrelated','keep']]);
  const accessed=[];
  const storage={getItem(key){accessed.push(key);return data.get(key)??null},setItem(key,value){accessed.push(key);data.set(key,value)}};
  assert.equal(noticeDismissed(storage),false);
  dismissNotice(storage);
  assert.equal(noticeDismissed(storage),true);
  assert.deepEqual([...new Set(accessed)],[STORAGE_NOTICE_KEY]);
  assert.deepEqual([...data],[['sb-fixture-auth-token','private session fixture'],['unrelated','keep'],[STORAGE_NOTICE_KEY,'dismissed']]);
});
test('blocked or unavailable storage does not break notice dismissal or sign-in UI',()=>{
  const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}};
  assert.equal(noticeDismissed(blocked),false);
  assert.doesNotThrow(()=>dismissNotice(blocked));
  assert.equal(noticeDismissed(),false);
  assert.doesNotThrow(()=>dismissNotice());
});
test('only an explicit dismissal value hides the informational notice',()=>{
  for(const value of [null,'','true','accepted','rejected'])assert.equal(noticeDismissed({getItem:()=>value}),false);
  assert.equal(noticeDismissed({getItem:()=>'dismissed'}),true);
});
