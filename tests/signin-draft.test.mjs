import test from 'node:test';
import assert from 'node:assert/strict';
import {SIGNIN_DRAFT_KEY,SIGNIN_DRAFT_TTL_MS,MAX_CHARS,SIGNIN_DRAFT_MAX_CHARS,
  saveSignInDraft,readSignInDraft,consumeSignInDraft,clearSignInDraft} from '../src/signin-draft.ts';

const NOW=Date.UTC(2026,9,29,12);
const ORIGIN='https://projecta.supabase.co',OTHER_ORIGIN='https://projectb.supabase.co';
const UUID_A='11111111-1111-4111-8111-111111111111',UUID_B='22222222-2222-4222-8222-222222222222';
const input=(overrides={})=>({text:'  First line\n\nSecond line.\t🙂 e\u0301  ',reasoned:true,authOrigin:ORIGIN,ownerId:null,...overrides});
const record=(overrides={})=>({version:1,attemptId:UUID_A,createdAt:NOW,...input(),...overrides});
function fixture(entries=[]){
  const data=new Map(entries),calls=[];
  const reader=()=>({
    getItem(key){calls.push(['get',key]);return data.get(key)??null;},
    setItem(key,value){calls.push(['set',key]);data.set(key,value);},
    removeItem(key){calls.push(['remove',key]);data.delete(key);},
    clear(){assert.fail('Never clear origin-wide storage');},
    key(){assert.fail('Never enumerate browser storage');},
  });
  return {data,calls,reader,storage:reader()};
}

test('an anonymous draft survives a redirect reader with exact text/mode and restores only once',()=>{
  const f=fixture([['sb-project-auth-token','private session'],['sb-project-auth-token-code-verifier','private verifier']]);
  const original=input(),id=saveSignInDraft(f.storage,original,NOW);
  assert.equal(typeof id,'string');
  const raw=f.data.get(SIGNIN_DRAFT_KEY),afterRedirect=f.reader();
  const pending=readSignInDraft(afterRedirect,ORIGIN,NOW+1000);
  assert.deepEqual(pending,{version:1,attemptId:id,createdAt:NOW,...original});
  assert.equal(f.data.get(SIGNIN_DRAFT_KEY),raw,'Reading must not rewrite or extend the draft');
  const restored=consumeSignInDraft(afterRedirect,{authOrigin:ORIGIN,userId:'account-a'},NOW+2000);
  assert.deepEqual(restored,pending);
  assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false,'Remove the stored prompt before returning it');
  assert.equal(consumeSignInDraft(f.reader(),{authOrigin:ORIGIN,userId:'account-a'},NOW+2001),null);
  assert.equal(readSignInDraft(f.reader(),ORIGIN,NOW+2002),null);
  assert.deepEqual([...f.data],[['sb-project-auth-token','private session'],['sb-project-auth-token-code-verifier','private verifier']]);
  assert.deepEqual([...new Set(f.calls.map(([,key])=>key))],[SIGNIN_DRAFT_KEY]);
});

test('an originally anonymous draft may also restore before a session arrives',()=>{
  const f=fixture();saveSignInDraft(f.storage,input({reasoned:false}),NOW);
  const restored=consumeSignInDraft(f.storage,{authOrigin:ORIGIN,userId:null},NOW);
  assert.equal(restored.reasoned,false);assert.equal(restored.ownerId,null);
  assert.equal(f.data.size,0);
});

test('an owned draft waits for its owner, restores for that owner, and is deleted for a different account',()=>{
  const f=fixture();
  saveSignInDraft(f.storage,input({ownerId:'account-a'}),NOW);
  const raw=f.data.get(SIGNIN_DRAFT_KEY);
  assert.equal(consumeSignInDraft(f.storage,{authOrigin:ORIGIN,userId:null},NOW+1),null);
  assert.equal(f.data.get(SIGNIN_DRAFT_KEY),raw,'Auth loading must leave an owner-bound attempt pending');
  assert.equal(consumeSignInDraft(f.storage,{authOrigin:ORIGIN,userId:'account-a'},NOW+2).text,input().text);
  assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
  saveSignInDraft(f.storage,input({ownerId:'account-a'}),NOW+3);
  assert.equal(consumeSignInDraft(f.storage,{authOrigin:ORIGIN,userId:'account-b'},NOW+4),null);
  assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
});

test('a different auth project is purged without changing authentication or unrelated keys',()=>{
  const f=fixture([['sb-auth-token','keep'],['unrelated','keep too']]);
  saveSignInDraft(f.storage,input(),NOW);
  assert.equal(readSignInDraft(f.storage,OTHER_ORIGIN,NOW),null);
  assert.deepEqual([...f.data],[['sb-auth-token','keep'],['unrelated','keep too']]);
  saveSignInDraft(f.storage,input(),NOW);
  assert.equal(consumeSignInDraft(f.storage,{authOrigin:OTHER_ORIGIN,userId:'account-a'},NOW),null);
  assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
});

test('the ten-minute lifetime is fixed at creation and expires at the exact boundary',()=>{
  const f=fixture();saveSignInDraft(f.storage,input(),NOW);
  const raw=f.data.get(SIGNIN_DRAFT_KEY);
  assert.equal(SIGNIN_DRAFT_TTL_MS,10*60*1000);
  assert.equal(readSignInDraft(f.storage,ORIGIN,NOW+1).createdAt,NOW);
  assert.equal(readSignInDraft(f.reader(),ORIGIN,NOW+SIGNIN_DRAFT_TTL_MS-1).createdAt,NOW);
  assert.equal(f.data.get(SIGNIN_DRAFT_KEY),raw);
  assert.equal(readSignInDraft(f.storage,ORIGIN,NOW+SIGNIN_DRAFT_TTL_MS),null);
  assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
});

test('future timestamps and invalid clocks cannot save or restore a draft',()=>{
  for(const createdAt of [NOW+1,NOW+SIGNIN_DRAFT_TTL_MS,0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
    const f=fixture([[SIGNIN_DRAFT_KEY,JSON.stringify(record({createdAt}))]]);
    assert.equal(readSignInDraft(f.storage,ORIGIN,NOW),null,String(createdAt));
    assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
  }
  for(const now of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){
    const f=fixture([[SIGNIN_DRAFT_KEY,JSON.stringify(record())]]);
    assert.equal(readSignInDraft(f.storage,ORIGIN,now),null);
    assert.equal(saveSignInDraft(f.storage,input(),now),null);
    assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
  }
});

test('malformed, oversized and unexpected schema values are purged',()=>{
  const missingOwner=record();delete missingOwner.ownerId;
  const cases=[null,'','not json','{','null','[]','true',JSON.stringify(missingOwner),
    JSON.stringify(record({version:2})),JSON.stringify(record({attemptId:'old-attempt'})),
    JSON.stringify(record({createdAt:String(NOW)})),JSON.stringify(record({text:42})),
    JSON.stringify(record({text:' \n\t'})),JSON.stringify(record({reasoned:'true'})),
    JSON.stringify(record({ownerId:''})),JSON.stringify(record({ownerId:{id:'account-a'}})),
    JSON.stringify(record({authOrigin:ORIGIN+'/'})),JSON.stringify(record({extra:'unexpected'})),
    JSON.stringify(record({text:'x'.repeat(MAX_CHARS+1)})),
    ' '.repeat(6*MAX_CHARS+20000)];
  for(const raw of cases){
    const f=fixture([[SIGNIN_DRAFT_KEY,raw],['sb-auth-token','keep']]);
    assert.equal(readSignInDraft(f.storage,ORIGIN,NOW),null);
    if(raw!==null)assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
    assert.equal(f.data.get('sb-auth-token'),'keep');
  }
});

test('only a canonical exact HTTPS auth origin can create or restore a handoff',()=>{
  for(const authOrigin of ['',ORIGIN+'/',ORIGIN+'/auth',ORIGIN+'?next=elsewhere',
    'http://projecta.supabase.co','https://user:password@projecta.supabase.co','https://PROJECTA.supabase.co','not a URL']){
    const f=fixture([[SIGNIN_DRAFT_KEY,JSON.stringify(record())]]);
    assert.equal(saveSignInDraft(f.storage,input({authOrigin}),NOW),null,authOrigin);
    assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
    f.data.set(SIGNIN_DRAFT_KEY,JSON.stringify(record()));
    assert.equal(readSignInDraft(f.storage,authOrigin,NOW),null,authOrigin);
    assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
  }
});

test('blank, invalid or oversized new input cannot revive an older saved prompt',()=>{
  for(const value of [input({text:''}),input({text:' \n\t\u2003'}),input({text:'x'.repeat(MAX_CHARS+1)}),
    input({text:null}),input({reasoned:1}),input({ownerId:''}),input({ownerId:' '.repeat(2)})]){
    const f=fixture([[SIGNIN_DRAFT_KEY,JSON.stringify(record())],['sb-auth-token','keep']]);
    assert.equal(saveSignInDraft(f.storage,value,NOW),null);
    assert.deepEqual([...f.data],[['sb-auth-token','keep']]);
    assert.equal(f.calls.some(([operation])=>operation==='set'),false);
  }
});

test('large Unicode and escaped strings remain exact, and over-limit input is never truncated',()=>{
  assert.equal(MAX_CHARS,65536);assert.equal(SIGNIN_DRAFT_MAX_CHARS,MAX_CHARS);
  for(const text of ['🙂'.repeat(MAX_CHARS/2),'\n'.repeat(MAX_CHARS-1)+'x',' \u0000\ud800 e\u0301\n🙂  ']){
    const f=fixture();
    assert.equal(typeof saveSignInDraft(f.storage,input({text}),NOW),'string');
    assert.equal(readSignInDraft(f.storage,ORIGIN,NOW).text,text);
    assert.equal(consumeSignInDraft(f.storage,{authOrigin:ORIGIN,userId:null},NOW).text,text);
    assert.equal(f.data.size,0);
  }
  const f=fixture();
  assert.equal(saveSignInDraft(f.storage,input({text:'🙂'.repeat(MAX_CHARS/2)+'x'}),NOW),null);
  assert.equal(f.data.size,0);
});

test('unavailable, throwing and no-op storage fail safely without logging or clearing other keys',()=>{
  const blocked={getItem(){throw Error('private')},setItem(){throw Error('private')},removeItem(){throw Error('private')}};
  for(const storage of [undefined,blocked]){
    assert.equal(saveSignInDraft(storage,input(),NOW),null);
    assert.equal(readSignInDraft(storage,ORIGIN,NOW),null);
    assert.equal(consumeSignInDraft(storage,{authOrigin:ORIGIN,userId:null},NOW),null);
    assert.doesNotThrow(()=>clearSignInDraft(storage));
    assert.doesNotThrow(()=>clearSignInDraft(storage,UUID_A));
  }
  const f=fixture([['sb-auth-token','keep']]);
  assert.equal(saveSignInDraft({...f.storage,setItem(){}},input(),NOW),null);
  assert.deepEqual([...f.data],[['sb-auth-token','keep']]);
  assert.equal(saveSignInDraft({...f.storage,setItem(key,value){f.data.set(key,value);throw Error('write failed after storing');}},input(),NOW),null);
  assert.deepEqual([...f.data],[['sb-auth-token','keep']]);
});

test('save requires an exact readback and cleans up only the failed attempt',()=>{
  const f=fixture();
  const changed={...f.storage,setItem(key,value){f.data.set(key,JSON.stringify({...JSON.parse(value),text:'changed'}));}};
  assert.equal(saveSignInDraft(changed,input(),NOW),null);
  assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
  const newer=JSON.stringify(record({attemptId:UUID_B,text:'newer prompt'}));
  const replaced={...f.storage,setItem(key){f.data.set(key,newer);throw Error('older request failed');}};
  assert.equal(saveSignInDraft(replaced,input(),NOW),null);
  assert.equal(f.data.get(SIGNIN_DRAFT_KEY),newer,'A stale save failure cannot erase a newer attempt');
});

test('blocked or ineffective removal never returns a draft for restoration',()=>{
  for(const removeItem of [()=>{throw Error('blocked')},()=>{}]){
    const raw=JSON.stringify(record()),f=fixture([[SIGNIN_DRAFT_KEY,raw]]);
    assert.equal(consumeSignInDraft({...f.storage,removeItem},{authOrigin:ORIGIN,userId:null},NOW),null);
    assert.equal(f.data.get(SIGNIN_DRAFT_KEY),raw);
    assert.equal(consumeSignInDraft(f.storage,{authOrigin:ORIGIN,userId:null},NOW).text,record().text);
    assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
  }
});

test('cancellation IDs are unique and a stale cancellation cannot remove a newer draft',()=>{
  const f=fixture([['sb-auth-token','keep']]);
  const first=saveSignInDraft(f.storage,input({text:'first'}),NOW);
  const second=saveSignInDraft(f.storage,input({text:'second'}),NOW);
  assert.notEqual(first,second);
  const raw=f.data.get(SIGNIN_DRAFT_KEY);
  clearSignInDraft(f.storage,first);assert.equal(f.data.get(SIGNIN_DRAFT_KEY),raw);
  clearSignInDraft(f.storage,'invalid');assert.equal(f.data.get(SIGNIN_DRAFT_KEY),raw);
  clearSignInDraft(f.storage,second);assert.equal(f.data.has(SIGNIN_DRAFT_KEY),false);
  saveSignInDraft(f.storage,input(),NOW);clearSignInDraft(f.storage);
  assert.deepEqual([...f.data],[['sb-auth-token','keep']]);
});

test('a newer attempt appearing before consume removal remains pending',()=>{
  const older=JSON.stringify(record()),newer=JSON.stringify(record({attemptId:UUID_B,text:'newer'}));
  const f=fixture([[SIGNIN_DRAFT_KEY,older]]);let reads=0;
  const storage={...f.storage,getItem(key){if(++reads===2)f.data.set(SIGNIN_DRAFT_KEY,newer);return f.storage.getItem(key);}};
  assert.equal(consumeSignInDraft(storage,{authOrigin:ORIGIN,userId:null},NOW),null);
  assert.equal(f.data.get(SIGNIN_DRAFT_KEY),newer);
});
