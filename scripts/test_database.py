"""Exercise real PostgreSQL RLS/admission with disposable dummy accounts only.

Requires a container labelled offscript.testing=1 and database offscript_test.
Never accepts a remote database URL or production credentials.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import time
import uuid

parser=argparse.ArgumentParser()
parser.add_argument('--container',required=True)
args=parser.parse_args()
container=args.container
label=subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "offscript.testing"}}',container],text=True).strip()
assert label=='1','Refusing a container without the disposable test label'
for attempt in range(120):
    main=subprocess.run(['docker','exec',container,'cat','/proc/1/comm'],capture_output=True,text=True,timeout=5)
    if main.stdout.strip()=='postgres':break
    time.sleep(.5)
else:raise RuntimeError('Final PostgreSQL process did not start')
checks=[]
A='11111111-1111-4111-8111-111111111111'
B='22222222-2222-4222-8222-222222222222'

def query(sql,role=None,subject=None,error=None):
    prefix=''
    if role:
        assert role in ('authenticated','anon','offscript_gateway','offscript_runtime')
        prefix+=f'SET ROLE {role};\n'
    if subject:
        assert str(uuid.UUID(subject))==subject
        prefix+=f"SET request.jwt.claim.sub='{subject}';\n"
    result=subprocess.run(['docker','exec','-i',container,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-d','offscript_test'],input=prefix+sql,text=True,capture_output=True,timeout=20)
    if error:
        assert result.returncode!=0 and error in result.stderr, (error,result.stdout,result.stderr)
        return result.stderr
    assert result.returncode==0,result.stderr
    return result.stdout.strip()

def check(name,condition=True):
    assert condition,name
    checks.append(name)
    print('PASS '+name,flush=True)

def account(user):return json.loads(query(f"SELECT offscript_api.account('{user}');",'offscript_gateway'))
def accept(user,terms='terms-test-v1'):
    return query(f"SELECT offscript_api.accept_policies('{user}','{terms}','privacy-test-v1');",'offscript_gateway')
def reserve(user,mode='fast',request=None,error=None):
    request=request or str(uuid.uuid4())
    text=query(f"SELECT offscript_api.reserve_request('{user}','{request}','{mode}',256);",'offscript_gateway',error=error)
    return request,text

def finish(user,request,outcome='completed',stopped=True):
    return json.loads(query(f"SELECT offscript_api.finish_request('{user}','{request}','{outcome}',8,24,{str(stopped).lower()});",'offscript_gateway'))

check('disposable database guard',query('SELECT current_database();')=='offscript_test')
query('''REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
''')
root=Path(__file__).resolve().parent.parent
query((root/'supabase/migrations/202610170001_pilot_accounts.sql').read_text())
check('migration applies')
query(f"INSERT INTO auth.users VALUES('{A}'),('{B}');")
check('account defaults do not grant serving eligibility',account(A)['status']=='pending' and account(A)['eligibility']=='pending')
account(B)
query(f"SELECT offscript_api.accept_policies('{A}','2026-10-17-draft','2026-10-17-draft');",'offscript_gateway',error='policy_unavailable')
check('draft policies cannot be accepted')
query('''UPDATE public.offscript_accounts SET status='active',eligibility='eligible';
UPDATE offscript_private.settings SET policies_published=true,terms_version='terms-test-v1',privacy_version='privacy-test-v1';''')
reserve(A,error='acceptance_required')
check('direct admission requires current acceptance')
accept(A);accept(B)
check('acceptance is recorded once',account(A)['policies']['accepted'])
query(f"SELECT offscript_api.accept_policies('{A}','old-version','privacy-test-v1');",'offscript_gateway',error='policy_changed')
check('outdated policy versions fail')
for table in ['offscript_accounts','offscript_policy_acceptances','offscript_usage_daily']:
    check('other user cannot read '+table,query(f"SELECT count(*) FROM public.{table} WHERE user_id='{A}';",'authenticated',B)=='0')
    query(f'SELECT * FROM public.{table};','anon',error='permission denied')
    query(f"DELETE FROM public.{table} WHERE user_id='{A}';",'authenticated',A,error='permission denied')
check('anonymous reads and client deletion are denied')
check('owner can read own account',query(f"SELECT count(*) FROM public.offscript_accounts WHERE user_id='{A}';",'authenticated',A)=='1')
for assignment in ["status='active'","plan='paid'",f"user_id='{B}'","eligibility='eligible'"]:
    query(f"UPDATE public.offscript_accounts SET {assignment} WHERE user_id='{A}';",'authenticated',A,error='permission denied')
query(f"INSERT INTO public.offscript_accounts(user_id) VALUES('{A}');",'authenticated',A,error='permission denied')
check('plan, eligibility and ownership cannot be client-written')
query(f"SELECT offscript_api.account('{B}');",'authenticated',A,error='permission denied')
query('SELECT * FROM public.offscript_accounts;','offscript_gateway',error='permission denied')
check('backend is restricted to its SQL API and clients cannot call it')
query('CREATE ROLE offscript_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION; GRANT offscript_gateway TO offscript_runtime;')
check('dedicated runtime member can call SQL API',json.loads(query(f"SELECT offscript_api.account('{A}');",'offscript_runtime'))['plan']=='free')
query('SELECT * FROM public.offscript_accounts;','offscript_runtime',error='permission denied')
query('SELECT * FROM offscript_private.settings;','offscript_runtime',error='permission denied')
check('runtime member cannot read tables or inherit owner access',query("SELECT pg_has_role(current_user,'offscript_gateway','MEMBER') AND NOT pg_has_role(current_user,'offscript_data_owner','MEMBER');",'offscript_runtime')=='t')
check('application roles have no bypass/login/superuser',query("SELECT count(*) FROM pg_roles WHERE rolname IN ('offscript_data_owner','offscript_gateway') AND (rolsuper OR rolbypassrls OR rolcanlogin);")=='0')
check('all five tables force RLS',query("SELECT count(*) FROM pg_class WHERE relname IN ('offscript_accounts','offscript_policy_acceptances','offscript_usage_daily','settings','inference_leases') AND relrowsecurity AND relforcerowsecurity;")=='5')
query(f"SELECT offscript_api.reserve_request('{A}','{uuid.uuid4()}','research',256);",'offscript_gateway',error='invalid_request')
check('unknown mode cannot reserve capacity')
# Competing independent connections represent two API replicas.
def competing(user):
    request=str(uuid.uuid4())
    try:
        reserve(user,request=request)
        return user,request,True
    except AssertionError as exc:
        assert 'capacity_busy' in str(exc)
        return user,request,False
with ThreadPoolExecutor(max_workers=2) as executor:outcomes=list(executor.map(competing,[A,B]))
check('two replicas cannot oversubscribe one global slot',sum(x[2] for x in outcomes)==1)
user,request,_=next(x for x in outcomes if x[2])
reserve(user,error='request_in_progress')
check('one account cannot start concurrent inference')
finish(user,request)
first=account(user)['usage']['requestsRemaining']
finish(user,request)
check('settlement is idempotent',account(user)['usage']['requestsRemaining']==first)
request,_=reserve(A)
finish(A,request,stopped=False)
query(f"UPDATE offscript_private.inference_leases SET deadline=now()-interval '1 day' WHERE request_id='{request}';")
reserve(B,error='capacity_busy')
check('expired uncertain work still occupies capacity')
finish(A,request,'cancelled')
request,_=reserve(B);finish(B,request,'rejected')
check('confirmed worker stop releases capacity; pre-start rejection refunds request')
query('UPDATE public.offscript_usage_daily SET requests_used=0,deep_used=0,tokens_used=0; UPDATE offscript_private.settings SET daily_requests=1;')
request,_=reserve(A);finish(A,request)
reserve(A,error='quota_exceeded')
check('daily quota cannot be bypassed by another API instance')
query('UPDATE offscript_private.settings SET daily_requests=10,daily_deep_requests=1;')
request,_=reserve(B,'deep');finish(B,request)
reserve(B,'deep',error='quota_exceeded')
check('Deep has its own daily allowance')
query("UPDATE offscript_private.settings SET terms_version='terms-test-v2';")
check('changed terms invalidate previous acceptance',not account(A)['policies']['accepted'])
reserve(A,error='acceptance_required');accept(A,'terms-test-v2')
request,_=reserve(A);finish(A,request)
check('accepting current version restores eligibility without changing plan')
query("UPDATE offscript_private.inference_leases SET finished_at=now()-interval '2 days' WHERE state='finished';")
query('SELECT offscript_api.prune_metadata();','offscript_gateway')
check('finished request metadata expires',query("SELECT count(*) FROM offscript_private.inference_leases WHERE state='finished';")=='0')
check('no conversation columns exist',query("SELECT count(*) FROM information_schema.columns WHERE (table_name LIKE 'offscript_%' OR table_schema='offscript_private') AND column_name IN ('prompt','content','messages','response','reply','reasoning');")=='0')
query(f"DELETE FROM auth.users WHERE id='{A}';")
check('account deletion cascades to account, policy and usage records',query(f"SELECT (SELECT count(*) FROM public.offscript_accounts WHERE user_id='{A}')+(SELECT count(*) FROM public.offscript_policy_acceptances WHERE user_id='{A}')+(SELECT count(*) FROM public.offscript_usage_daily WHERE user_id='{A}');")=='0')
print(json.dumps({'database_checks':len(checks),'result':'passed'}),flush=True)
