// Parent-run isolated fixture only. Never accepts a connection URL or account.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {pruneMetadata} from './prune-metadata.mjs';

assert.equal(process.env.OFFSCRIPT_TEST_FIXTURE,'disposable-postgres');
const require=createRequire(new URL('../cloud/vercel-gateway/package.json',import.meta.url));
const {Pool}=require('pg');
const db=new Pool({host:'127.0.0.1',port:5432,database:'offscript_test',user:'postgres',password:'disposable-test-only',max:1,connectionTimeoutMillis:3000,query_timeout:5000});
const client=await db.connect();
let transaction=false,passed=false;
try {
  assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name,'offscript_test');
  assert.notEqual((await client.query("SELECT to_regclass('offscript_private.answers') AS installed")).rows[0].installed,null);
  await client.query('BEGIN');transaction=true;
  const users=[randomUUID(),randomUUID(),randomUUID()],answers=[randomUUID(),randomUUID(),randomUUID()],requests=[randomUUID(),randomUUID(),randomUUID()];
  const states=['finished','active','uncertain'];
  for(let index=0;index<3;index++){
    const finished=index===0;
    await client.query('INSERT INTO auth.users(id) VALUES($1::uuid)',[users[index]]);
    await client.query('INSERT INTO public.offscript_accounts(user_id) VALUES($1::uuid)',[users[index]]);
    await client.query(`INSERT INTO public.offscript_usage_daily(user_id,day,requests_used,requests_reserved,tokens_used,tokens_reserved)
      VALUES($1::uuid,(now() AT TIME ZONE 'UTC')::date-40,$2,$3,$4,$5)`,[users[index],finished?1:0,finished?0:1,finished?30:0,finished?0:4096]);
    await client.query(`INSERT INTO offscript_private.answers(answer_id,user_id,mode,day,consumed_tokens,state,outcome,last_request_id,created_at,finished_at)
      VALUES($1::uuid,$2::uuid,'fast',(now() AT TIME ZONE 'UTC')::date-40,$3,$4,$5,$6::uuid,now()-interval '2 days',CASE WHEN $7::boolean THEN now()-interval '2 days' END)`,
      [answers[index],users[index],finished?30:0,states[index],finished?'completed':null,requests[index],finished]);
    await client.query(`INSERT INTO offscript_private.answer_segments(request_id,answer_id,worker_id,sequence,output_allowance,state,outcome,created_at,deadline,finished_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,1,256,$4,$5,now()-interval '2 days',now()-interval '2 days',CASE WHEN $6::boolean THEN now()-interval '2 days' END)`,
      [requests[index],answers[index],randomUUID(),states[index],finished?'completed':null,finished]);
  }
  const snapshot=async()=> (await client.query(`SELECT
    (SELECT count(*)::int FROM offscript_private.answers WHERE answer_id=ANY($1::uuid[])) AS answers,
    (SELECT count(*)::int FROM offscript_private.answer_segments WHERE request_id=ANY($2::uuid[])) AS segments,
    (SELECT count(*)::int FROM public.offscript_usage_daily WHERE user_id=ANY($3::uuid[])) AS daily`,[answers,requests,users])).rows[0];
  const before=await snapshot();assert.deepEqual(before,{answers:3,segments:3,daily:3});
  const env={PILOT_DATABASE_URL:'postgresql://offscript_runtime:dummy@db.fixture.supabase.co/postgres'};
  const check=await pruneMetadata({env,poolFactory:()=>{assert.fail('Check must not connect');}});
  assert.equal(check.applied,false);assert.deepEqual(await snapshot(),before);
  const runtime=new EventEmitter();runtime.end=async()=>{};
  runtime.query=async(sql)=>{
    await client.query('SET LOCAL ROLE offscript_runtime');
    try {return await client.query(sql);}
    finally {await client.query('RESET ROLE');}
  };
  assert.equal((await pruneMetadata({mode:'apply',env,poolFactory:()=>runtime})).applied,true);
  assert.deepEqual(await snapshot(),{answers:2,segments:2,daily:2});
  assert.deepEqual((await client.query('SELECT state FROM offscript_private.answers WHERE answer_id=ANY($1::uuid[]) ORDER BY state',[answers])).rows.map(row=>row.state),['active','uncertain']);
  assert.deepEqual((await client.query('SELECT state FROM offscript_private.answer_segments WHERE request_id=ANY($1::uuid[]) ORDER BY state',[requests])).rows.map(row=>row.state),['active','uncertain']);
  assert.deepEqual((await client.query('SELECT requests_reserved,tokens_reserved FROM public.offscript_usage_daily WHERE user_id=ANY($1::uuid[]) ORDER BY user_id',[users])).rows,[{requests_reserved:1,tokens_reserved:'4096'},{requests_reserved:1,tokens_reserved:'4096'}]);
  passed=true;
} finally {
  try {if(transaction)await client.query('ROLLBACK');}
  finally {client.release();await db.end();}
}
if(passed)console.log(JSON.stringify({retention_checks:5,result:'passed',database:'disposable',external_network:false,fixture_changes:'rolled_back'}));
