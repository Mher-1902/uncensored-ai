import test from 'node:test';
import assert from 'node:assert/strict';
import {completedHistory,restoreQuestion,retryTurn,settleAnswer} from '../src/conversation.ts';

const question=(id,content)=>({id,role:'user',content,complete:true});
const answer=(id,questionId,content,state='complete')=>({id,questionId,role:'assistant',content,state,complete:state==='complete'});

test('a next draft survives a failed or stopped first answer; an empty draft recovers the question',()=>{
  const original='Explain this function';
  assert.equal(restoreQuestion('Now write its tests',original),'Now write its tests');
  assert.equal(restoreQuestion('',original),original);
});
test('only completed exchanges enter a subsequent model request while partial replies stay visible',()=>{
  const first=[question('q1','Hello'),answer('a1','q1','Hi')];
  const failed=[...first,question('q2','Code please'),answer('a2','q2','function partial(', 'streaming')];
  const stopped=settleAnswer(failed,'a2','function partial(','stopped');
  assert.equal(stopped.at(-1).content,'function partial(');
  assert.equal(stopped.at(-1).complete,false);
  assert.deepEqual(completedHistory(stopped),first);
  const later=[...stopped,question('q3','Another question'),answer('a3','q3','A full answer')];
  assert.deepEqual(completedHistory(later),[...first,...later.slice(-2)]);
  const interrupted=settleAnswer(failed,'a2','function partial(','interrupted');
  assert.deepEqual(completedHistory(interrupted),first);
});
test('retry keeps original mode/context and refuses to replace earlier or already completed answers',()=>{
  const first=[question('q1','Hello'),answer('a1','q1','Hi')];
  const failed=[...first,question('q2','Explain recursion'),{...answer('a2','q2','Partial','interrupted'),reasoned:true}];
  const retry=retryTurn(failed,'a2');
  assert.equal(retry.question.content,'Explain recursion');
  assert.equal(retry.answer.reasoned,true);
  assert.deepEqual(retry.history,first);
  assert.equal(retryTurn([...failed,question('q3','New question')],'a2'),null);
  assert.equal(retryTurn(settleAnswer(failed,'a2','Done','complete'),'a2'),null);
  assert.equal(retryTurn(failed,'a1'),null);
});
