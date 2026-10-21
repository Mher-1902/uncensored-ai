import test from 'node:test';
import assert from 'node:assert/strict';
import {accountSessionProvider,sessionReader,SessionExpiredError,AccountChangedError} from '../src/session.ts';

const stored=(token='first',user='account-a')=>({data:{session:{access_token:token,user:{id:user}}},error:null});
test('a conversation resolves renewed credentials for its original account',async()=>{
  let value=stored(),reads=0,refreshes=0;
  const auth={async getSession(){reads++;return value},async refreshSession(){refreshes++;return stored('forced')}};
  const read=sessionReader(accountSessionProvider(auth,'account-a'),true);
  assert.equal(await read.token(),'first');
  value=stored('rotated');assert.equal(await read.token(),'rotated');
  assert.equal(await read.token(true),'forced');assert.equal(reads,2);assert.equal(refreshes,1);
});
test('an expired or missing session fails closed without accepting a different account',async()=>{
  const auth={async getSession(){return stored('private-b','account-b')},async refreshSession(){return stored('private-b','account-b')}};
  const read=sessionReader(accountSessionProvider(auth,'account-a'),true);
  await assert.rejects(read.token(),AccountChangedError);
  await assert.rejects(read.token(true),AccountChangedError);
  for(const value of [{data:{session:null},error:null},{data:{session:null},error:Error('private diagnostic')}]) {
    const failed={async getSession(){return value},async refreshSession(){return value}};
    await assert.rejects(sessionReader(accountSessionProvider(failed,'account-a'),true).token(),SessionExpiredError);
  }
  await assert.rejects(sessionReader(null,true).token(),SessionExpiredError);
});
test('even a caller-supplied resolver cannot switch account halfway through a reply',async()=>{
  let userId='account-a';const read=sessionReader(async()=>({accessToken:'fixture',userId}),true);
  assert.equal(await read.token(),'fixture');userId='account-b';
  await assert.rejects(read.token(),AccountChangedError);
  await assert.rejects(read.token(true),AccountChangedError);
});
test('Stop rejects promptly during a pending token lookup and removes the abort listener',async()=>{
  const controller=new AbortController();let resolve;
  const pending=new Promise(r=>{resolve=r});const read=sessionReader(()=>pending,true);
  const token=read.token(false,controller.signal);controller.abort();
  await assert.rejects(token,{name:'AbortError'});
  resolve({accessToken:'late',userId:'account-a'});
  await assert.rejects(read.token(false,controller.signal),{name:'AbortError'});
});
