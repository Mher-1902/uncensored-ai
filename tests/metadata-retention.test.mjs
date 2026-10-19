import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {maintenanceMode,pruneMetadata} from '../scripts/prune-metadata.mjs';

const env={PILOT_DATABASE_URL:'postgresql://offscript_runtime:disposable-only@db.fixture.supabase.co/postgres'};
function fixture(role={name:'offscript_runtime',restricted:true,can_prune:true}){
  const calls=[];let ended=false;
  const pool=new EventEmitter();
  pool.query=async(sql)=>{calls.push(sql);return {rows:sql==='SELECT offscript_api.prune_metadata()'?[{prune_metadata:''}]:[role]};};
  pool.end=async()=>{ended=true;};
  return {pool,calls,ended:()=>ended};
}

test('default and check modes validate offline without creating a database client',async()=>{
  assert.equal(maintenanceMode([]),'check');assert.equal(maintenanceMode(['--check']),'check');
  const result=await pruneMetadata({env,poolFactory:()=>{throw Error('A check must not create a pool');}});
  assert.deepEqual(result,{mode:'check',configurationValid:true,databaseContacted:false,applied:false});
  assert.equal(maintenanceMode(['--apply']),'apply');
  for(const args of [['--apply','--check'],['--database-url','secret'],['--apply=true']])assert.throws(()=>maintenanceMode(args));
});
test('maintenance rejects privileged URLs and TLS bypass options without disclosing values',async()=>{
  for(const url of [env.PILOT_DATABASE_URL.replace('offscript_runtime:','postgres:'),env.PILOT_DATABASE_URL+'?sslmode=disable',env.PILOT_DATABASE_URL.replace('db.fixture.supabase.co','localhost')]){
    await assert.rejects(pruneMetadata({mode:'check',env:{PILOT_DATABASE_URL:url}}),error=>{
      assert.equal(error.message.includes(url),false);assert.equal(error.message.includes('disposable-only'),false);return /No database operation was attempted/.test(error.message);
    });
  }
});
test('explicit apply verifies restricted identity and invokes only the existing retention function',async()=>{
  const f=fixture();let settings;
  const result=await pruneMetadata({mode:'apply',env,poolFactory:config=>{settings=config;return f.pool;}});
  assert.deepEqual(result,{mode:'apply',databaseContacted:true,applied:true});
  assert.equal(settings.ssl.rejectUnauthorized,true);assert.equal(settings.max,1);
  assert.equal(settings.statement_timeout,4000);assert.equal(settings.query_timeout,5000);
  assert.equal(f.calls.length,2);assert.match(f.calls[0],/has_function_privilege/);
  assert.equal(f.calls[1],'SELECT offscript_api.prune_metadata()');assert.equal(f.ended(),true);
});
test('a wrong or overprivileged connected role cannot prune and database errors stay private',async()=>{
  for(const role of [{name:'postgres',restricted:true,can_prune:true},{name:'offscript_runtime',restricted:false,can_prune:true},{name:'offscript_runtime',restricted:true,can_prune:false}]){
    const f=fixture(role);
    await assert.rejects(pruneMetadata({mode:'apply',env,poolFactory:()=>f.pool}),/Metadata retention failed/);
    assert.equal(f.calls.length,1);assert.equal(f.ended(),true);
  }
  const f=fixture();f.pool.query=async()=>{throw Error('private credential disposable-only and database diagnostics');};
  await assert.rejects(pruneMetadata({mode:'apply',env,poolFactory:()=>f.pool}),error=>{
    assert.equal(error.message.includes('disposable-only'),false);assert.equal(error.message.includes('private credential'),false);return true;
  });
  assert.equal(f.ended(),true);
});
