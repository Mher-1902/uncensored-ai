"""Exercise real PostgreSQL RLS/admission with disposable dummy accounts only.

Requires a container labelled offscript.testing=1 and database offscript_test.
Never accepts a remote database URL or production credentials.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

parser=argparse.ArgumentParser()
fixture=parser.add_mutually_exclusive_group(required=True)
fixture.add_argument('--container')
fixture.add_argument('--local-fixture',action='store_true')
parser.add_argument('--provider-role',action='store_true',help='Migrate as a non-superuser project administrator')
args=parser.parse_args()
container=args.container
if args.local_fixture:
    assert os.environ.get('OFFSCRIPT_TEST_FIXTURE')=='disposable-postgres','Refusing an unmarked local fixture'
else:
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

def query(sql,role=None,subject=None,error=None,login='postgres'):
    assert login in ('postgres','project_migrator')
    prefix=''
    if role:
        assert role in ('authenticated','anon','offscript_gateway','offscript_runtime')
        prefix+=f'SET ROLE {role};\n'
    if subject:
        assert str(uuid.UUID(subject))==subject
        prefix+=f"SET request.jwt.claim.sub='{subject}';\n"
    command=['node',str(Path(__file__).with_name('test-database-client.mjs')),login] if args.local_fixture else ['docker','exec','-i',container,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U',login,'-d','offscript_test']
    result=subprocess.run(command,input=prefix+sql,text=True,capture_output=True,timeout=20)
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
if args.provider_role:
    query('''CREATE ROLE project_migrator LOGIN PASSWORD 'disposable-test-only' NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS;
    ALTER DATABASE offscript_test OWNER TO project_migrator;
    GRANT USAGE ON SCHEMA auth TO project_migrator;
    GRANT REFERENCES ON auth.users TO project_migrator;
    ''')
    check('provider fixture has the observed project privileges',query("SELECT NOT rolsuper AND rolcreaterole AND rolcreatedb AND rolbypassrls FROM pg_roles WHERE rolname=current_user;",login='project_migrator')=='t')
query((root/'supabase/migrations/202610170001_pilot_accounts.sql').read_text(),login='project_migrator' if args.provider_role else 'postgres')
check('migration applies')
check('bootstrap CREATE permission is removed from the data owner',query("SELECT has_schema_privilege('offscript_data_owner','public','CREATE');")=='f')
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
# The legacy foundation checks above also protect the already-applied migration.
# Upgrade in place and exercise the logical-answer API on independent clients.
query((root/'supabase/migrations/202610170002_logical_answers.sql').read_text(),login='project_migrator' if args.provider_role else 'postgres')
check('logical-answer migration applies over the foundation')
query(f"INSERT INTO auth.users VALUES('{A}') ON CONFLICT DO NOTHING;")
account(A)
query("UPDATE public.offscript_accounts SET status='active',eligibility='eligible'; UPDATE offscript_private.settings SET daily_requests=100,daily_deep_requests=100,daily_tokens=1000000;")
accept(A,'terms-test-v2');accept(B,'terms-test-v2')
worker='33333333-3333-4333-8333-333333333333'
other_worker='44444444-4444-4444-8444-444444444444'

def start_answer(user=A,mode='fast',error=None):
    answer,request=str(uuid.uuid4()),str(uuid.uuid4())
    result=query(f"SELECT offscript_api.start_answer('{user}','{answer}','{request}','{worker}','{mode}',256);",'offscript_gateway',error=error)
    return answer,request,None if error else json.loads(result)

def segment(user,answer,request,outcome='completed',prompt=8,completion=24,reason='stop',visible=True,stopped=True,process=worker,error=None):
    number=lambda value:'NULL' if value is None else str(value)
    result=query(f"SELECT offscript_api.finish_answer_segment('{user}','{answer}','{request}','{process}','{outcome}',{number(prompt)},{number(completion)},{'NULL' if reason is None else repr(reason)},{str(visible).lower()},{str(stopped).lower()});",'offscript_gateway',error=error)
    return None if error else json.loads(result)

def next_segment(user,answer,receipt,error=None):
    request=str(uuid.uuid4())
    result=query(f"SELECT offscript_api.continue_answer('{user}','{answer}','{receipt}','{request}','{worker}',256);",'offscript_gateway',error=error)
    return request,None if error else json.loads(result)

def cancel_answer(user,answer):return json.loads(query(f"SELECT offscript_api.cancel_answer('{user}','{answer}');",'offscript_gateway'))
def used(user):return json.loads(query(f"SELECT row_to_json(u) FROM public.offscript_usage_daily u WHERE user_id='{user}' AND day=CURRENT_DATE;"))
def reset_usage():query('UPDATE public.offscript_usage_daily SET requests_used=0,requests_reserved=0,deep_used=0,deep_reserved=0,tokens_used=0,tokens_reserved=0;')

query(f"SELECT offscript_api.reserve_request('{A}','{uuid.uuid4()}','fast',256);",'offscript_gateway',error='permission denied')
check('legacy worker admission cannot bypass logical-answer accounting')
check('seven tables force RLS after upgrade',query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ((n.nspname='public' AND c.relname LIKE 'offscript_%') OR n.nspname='offscript_private') AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity;")=='7')
for role in ['anon','authenticated','offscript_runtime']:
    for table in ['answers','answer_segments']:
        query('SELECT * FROM offscript_private.'+table+';',role,error='permission denied')
query(f"SELECT offscript_private.close_answer('{uuid.uuid4()}','completed',true);",'offscript_gateway',error='permission denied')
check('answer and worker metadata and closure helpers stay private')

reset_usage()
def competing_answers(user):
    try:
        answer,request,_=start_answer(user)
        return user,answer,request
    except AssertionError as exc:
        assert 'capacity_busy' in str(exc)
        return None
with ThreadPoolExecutor(max_workers=2) as executor: new_winners=list(executor.map(competing_answers,[A,B]))
check('logical-answer admission is atomic across independent API replicas',sum(value is not None for value in new_winners)==1)
winner=next(value for value in new_winners if value)
segment(*winner)
reset_usage()
answer,request,_=start_answer(mode='deep')
first=segment(A,answer,request,prompt=100,completion=300,reason='length')
check('a proven length segment issues one opaque continuation receipt',first['state']=='waiting' and str(uuid.UUID(first['receipt']))==first['receipt'])
check('one answer reserves one request, one Deep and one token allowance',used(A)['requests_reserved']==1 and used(A)['deep_reserved']==1 and used(A)['tokens_reserved']==4096 and used(A)['requests_used']==0)
start_answer(B,error='capacity_busy')
next_segment(B,answer,first['receipt'],error='answer_missing')
next_segment(A,answer,str(uuid.uuid4()),error='continuation_invalid')
check('waiting holds capacity and stolen-owner or forged receipts fail')
request2,admitted=next_segment(A,answer,first['receipt'])
next_segment(A,answer,first['receipt'],error='continuation_invalid')
segment(A,answer,request,error='worker_mismatch')
check('a receipt is single use and an older worker cannot settle a newer segment',admitted['maxTokens']==256)
second=segment(A,answer,request2,prompt=500,completion=50)
check('all segments count as one request and Deep allowance; hidden generation is charged, repeated prefill is not',second['outcome']=='completed' and used(A)['requests_used']==1 and used(A)['deep_used']==1 and used(A)['tokens_used']==450 and used(A)['tokens_reserved']==0)
segment(A,answer,request2,prompt=500,completion=50)
check('segment settlement is idempotent',used(A)['tokens_used']==450)

answer,request,_=start_answer()
first=segment(A,answer,request,reason='length')
def racing_continuation(_):
    try:return next_segment(A,answer,first['receipt'])[0]
    except AssertionError as exc:
        assert 'continuation_invalid' in str(exc)
        return None
with ThreadPoolExecutor(max_workers=2) as executor: winners=list(executor.map(racing_continuation,[1,2]))
check('two racing continuations start exactly one worker',sum(value is not None for value in winners)==1)
segment(A,answer,next(value for value in winners if value))

answer,request,_=start_answer()
first=segment(A,answer,request,reason='length')
check('Stop between segments closes a known-stopped answer immediately',cancel_answer(A,answer)['state']=='finished')
next_segment(A,answer,first['receipt'],error='continuation_invalid')
check('a late continuation cannot restart a stopped answer')
answer,request,_=start_answer()
stopping=cancel_answer(A,answer)
check('Stop during work returns the exact cleanup target without freeing capacity',stopping['requestId']==request and stopping['workerId']==worker and stopping['state']=='active')
query(f"DELETE FROM auth.users WHERE id='{A}';",error='account_in_progress')
check('account deletion cannot erase an occupied inference slot')
start_answer(B,error='capacity_busy')
segment(A,answer,request,process=other_worker,error='worker_mismatch')
check('a different gateway process cannot prove that the old model stopped')
check('matching worker acknowledgement settles cancellation',segment(A,answer,request,outcome='cancelled',reason=None)['outcome']=='cancelled')

answer,request,_=start_answer()
segment(A,answer,request,stopped=False)
query(f"UPDATE offscript_private.answer_segments SET deadline=now()-interval '2 days' WHERE request_id='{request}';")
query('SELECT offscript_api.expire_answer_handoffs();','offscript_gateway')
query('SELECT offscript_api.prune_metadata();','offscript_gateway')
start_answer(B,error='capacity_busy')
check('active/uncertain work survives deadline and retention; it never expires free')
segment(A,answer,request,outcome='cancelled',reason=None)

answer,request,_=start_answer()
first=segment(A,answer,request,reason='length')
query(f"UPDATE offscript_private.answers SET handoff_deadline=now()-interval '1 second' WHERE answer_id='{answer}';")
_,expired=next_segment(A,answer,first['receipt'])
check('expired waiting handoff commits a safe closure instead of dispatching',expired['outcome']=='expired')
answer,request,_=start_answer()
segment(A,answer,request,reason='length')
query(f"UPDATE offscript_private.answers SET handoff_deadline=now()-interval '1 second' WHERE answer_id='{answer}';")
check('scheduled expiry releases only known-stopped waiting answers',json.loads(query('SELECT offscript_api.expire_answer_handoffs();','offscript_gateway'))['expired']==1)

before=used(A)
answer,request,_=start_answer()
result=segment(A,answer,request,prompt=None,completion=None,reason='length')
check('unknown usage cannot continue and is conservatively charged',result['outcome']=='budget' and 'receipt' not in result and used(A)['tokens_used']==before['tokens_used']+4096)
before=used(A)
answer,request,_=start_answer()
segment(A,answer,request,outcome='rejected',prompt=None,completion=None,reason=None,visible=False)
check('confirmed initial pre-start rejection refunds the request',used(A)['requests_used']==before['requests_used'] and used(A)['tokens_used']==before['tokens_used'])
answer,request,_=start_answer()
first=segment(A,answer,request,prompt=10,completion=20,reason='length')
request2,_=next_segment(A,answer,first['receipt'])
segment(A,answer,request2,outcome='rejected',prompt=None,completion=None,reason=None,visible=False)
check('rejected continuation retains prior actual work and one request charge',used(A)['requests_used']==before['requests_used']+1 and used(A)['tokens_used']==before['tokens_used']+30)

# A large initial prompt and hidden generation nearly consume the logical budget.
answer,request,_=start_answer(mode='deep')
first=segment(A,answer,request,prompt=3800,completion=230,reason='length')
request2,admitted=next_segment(A,answer,first['receipt'])
check('continuation output is clamped to remaining logical budget including thinking',admitted['maxTokens']==66)
result=segment(A,answer,request2,prompt=4000,completion=66,reason='length')
check('exhausted logical budget cannot issue another continuation',result['state']=='finished' and result['outcome']=='budget' and 'receipt' not in result)

answer,request,_=start_answer()
first=segment(A,answer,request,reason='length')
query("UPDATE offscript_private.settings SET terms_version='terms-test-v3';")
next_segment(A,answer,first['receipt'],error='acceptance_required')
cancel_answer(A,answer)
accept(A,'terms-test-v3');accept(B,'terms-test-v3')
check('each continuation requires current policy acceptance')
answer,request,_=start_answer()
first=segment(A,answer,request,reason='length')
query(f"UPDATE public.offscript_accounts SET status='suspended' WHERE user_id='{A}';")
next_segment(A,answer,first['receipt'],error='account_restricted')
cancel_answer(A,answer)
query(f"UPDATE public.offscript_accounts SET status='active' WHERE user_id='{A}';")
check('account suspension also blocks an already-issued continuation receipt')

answer,request,_=start_answer()
result=segment(A,answer,request,reason='length',visible=False)
check('hidden-only generation is not treated as a continuable visible answer',result['state']=='finished' and 'receipt' not in result)
answer,request,_=start_answer()
for sequence in range(1,17):
    result=segment(A,answer,request,prompt=8,completion=1,reason='length')
    if sequence<16:request,_=next_segment(A,answer,result['receipt'])
check('a logical answer has at most sixteen worker segments',result['state']=='finished' and result['outcome']=='budget')

reset_usage()
query('UPDATE offscript_private.settings SET daily_requests=1,daily_deep_requests=1;')
answer,request,_=start_answer(mode='deep')
first=segment(A,answer,request,reason='length')
request,_=next_segment(A,answer,first['receipt'])
segment(A,answer,request)
start_answer(error='quota_exceeded')
check('a multi-segment answer uses exactly one daily request and one Deep allowance',used(A)['requests_used']==1 and used(A)['deep_used']==1)
query('UPDATE offscript_private.settings SET daily_requests=100,daily_deep_requests=100;')

query("UPDATE offscript_private.answers SET finished_at=now()-interval '2 days' WHERE state='finished';")
query('SELECT offscript_api.prune_metadata();','offscript_gateway')
check('finished answer and worker metadata are pruned together',query('SELECT (SELECT count(*) FROM offscript_private.answers WHERE state=\'finished\')+(SELECT count(*) FROM offscript_private.answer_segments);')=='0')
check('new tables have no conversation or identity-tracking fields',query("SELECT count(*) FROM information_schema.columns WHERE table_schema='offscript_private' AND column_name IN ('prompt','content','messages','response','reply','reasoning','ip','birthdate','oauth_token','content_hash');")=='0')
query(f"DELETE FROM auth.users WHERE id='{A}';")
check('account deletion cascades answer metadata after settlement',query(f"SELECT count(*) FROM offscript_private.answers WHERE user_id='{A}';")=='0')
if args.local_fixture:
    subprocess.run(['node',str(root/'scripts/test-answer-stack.mjs')],check=True,timeout=60)
print(json.dumps({'database_checks':len(checks),'result':'passed'}),flush=True)
