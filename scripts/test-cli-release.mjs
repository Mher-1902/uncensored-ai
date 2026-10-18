// Official CLI rehearsal for an isolated disposable database only.
// No host, URL, real password, project or arbitrary executable inputs are accepted.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from '../cloud/vercel-gateway/node_modules/pg/lib/index.js';

assert.equal(process.env.OFFSCRIPT_TEST_FIXTURE,'disposable-postgres','Not a disposable fixture');
assert.equal(process.argv.length,2,'Fixture takes no connection arguments');
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const cli='/vendor/supabase';
assert.equal(createHash('sha256').update(readFileSync(cli)).digest('hex'),
  'e91fc61f09c4fbb9c65dadc37d415640cb6d2398e65eba6d384eec74b2dbbe10','Unexpected vendor CLI binary');
const config={host:'127.0.0.1',port:5432,database:'offscript_test',password:'disposable-test-only',
  ssl:false,connectionTimeoutMillis:5000,statement_timeout:10000};
async function query(sql,user='postgres'){
  assert.ok(['postgres','project_migrator'].includes(user));
  const client=new pg.Client({...config,user});
  try{await client.connect();return await client.query(sql);}finally{await client.end();}
}
const initial=await query(`SELECT current_database() AS name,
  to_regclass('auth.users') IS NULL AND to_regclass('public.offscript_accounts') IS NULL
  AND NOT EXISTS(SELECT FROM pg_roles WHERE rolname LIKE 'offscript_%' OR rolname='project_migrator') AS empty`);
assert.deepEqual(initial.rows,[{name:'offscript_test',empty:true}],'Fixture must be a fresh isolated database');
await query(`REVOKE ALL ON SCHEMA public FROM PUBLIC;
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO authenticated;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
  CREATE ROLE project_migrator LOGIN PASSWORD 'disposable-test-only' NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS;
  ALTER DATABASE offscript_test OWNER TO project_migrator;
  GRANT USAGE ON SCHEMA auth TO project_migrator;
  GRANT REFERENCES ON auth.users TO project_migrator;`);
await query(readFileSync(join(root,'supabase/migrations/202610170001_pilot_accounts.sql'),'utf8'),'project_migrator');
const scratch=mkdtempSync('/tmp/offscript-cli-fixture-');
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:scratch,XDG_CONFIG_HOME:scratch,XDG_CACHE_HOME:scratch,
  DO_NOT_TRACK:'1',SUPABASE_TELEMETRY_DISABLED:'true',NO_COLOR:'1',PGPASSWORD:'disposable-test-only'};
const url='postgresql://project_migrator@127.0.0.1:5432/offscript_test?sslmode=disable';
function command(args,{fails=false}={}){
  const result=spawnSync(cli,[...args,'--db-url',url,'--workdir',scratch,'--agent','no'],
    {env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  assert.ifError(result.error);
  assert.equal(result.signal,null);
  if(fails)assert.notEqual(result.status,0);else assert.equal(result.status,0,result.stdout+result.stderr);
  return result.stdout+result.stderr;
}
try{
  const migrations=join(scratch,'supabase/migrations');mkdirSync(migrations,{recursive:true});
  writeFileSync(join(scratch,'supabase/config.toml'),'project_id = "offscript-cli-fixture"\n[db]\nport = 5432\nmajor_version = 17\n');
  for(const name of ['202610170001_pilot_accounts.sql','202610170002_logical_answers.sql'])
    copyFileSync(join(root,'supabase/migrations',name),join(migrations,name));
  command(['migration','repair','202610170001','--status','applied']);
  assert.deepEqual((await query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows,
    [{version:'202610170001'}]);
  console.log('PASS official CLI repairs only the previously applied foundation history');
  const plan=command(['db','push','--dry-run','--skip-vault']);
  assert.ok(plan.includes('202610170002_logical_answers.sql')&&!plan.includes('202610170001_pilot_accounts.sql'),plan);
  assert.equal((await query("SELECT to_regclass('offscript_private.answers') IS NULL AS absent")).rows[0].absent,true);
  console.log('PASS official CLI dry-run proposes only migration 002 and changes no application schema');
  command(['db','push','--skip-vault','--yes']);
  assert.deepEqual((await query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows,
    [{version:'202610170001'},{version:'202610170002'}]);
  assert.equal((await query(`SELECT count(*)::integer AS total FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='offscript_private' AND c.relname IN ('answers','answer_segments')
    AND c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='offscript_data_owner'`)).rows[0].total,2);
  console.log('PASS official CLI applies the logical-answer schema and updates history as managed-project role');
  const provisioning=join(root,'supabase/admin/provision_runtime.sql');
  command(['db','query','--file',provisioning]);
  assert.equal((await query(`SELECT NOT(rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
    AND rolconnlimit=6 AND pg_has_role(oid,'offscript_gateway','MEMBER')
    AND NOT pg_has_role(oid,'offscript_data_owner','MEMBER') AS restricted
    FROM pg_roles WHERE rolname='offscript_runtime'`)).rows[0].restricted,true);
  console.log('PASS official CLI executes atomic provisioning with only the restricted NOLOGIN role');
  assert.match(command(['db','query','--file',provisioning],{fails:true}),/Runtime role already exists/);
  assert.equal((await query("SELECT NOT rolcanlogin AND rolconnlimit=6 AS preserved FROM pg_roles WHERE rolname='offscript_runtime'")).rows[0].preserved,true);
  console.log('PASS official CLI reports overwrite refusal and preserves the existing runtime');
  const listing=command(['migration','list']);
  assert.ok(listing.includes('202610170001')&&listing.includes('202610170002'));
  assert.equal((await query('SELECT NOT policies_published AS unpublished FROM offscript_private.settings WHERE singleton')).rows[0].unpublished,true);
  console.log('PASS final migration list agrees and policy activation remains disabled');
  console.log(JSON.stringify({cli_release_checks:6,result:'passed',cli:'2.121.0',database:'disposable',external_network:false}));
}finally{delete env.PGPASSWORD;rmSync(scratch,{recursive:true,force:true});}
