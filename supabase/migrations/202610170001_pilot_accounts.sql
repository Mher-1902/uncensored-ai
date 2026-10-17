-- Account metadata only. Never add conversation content to this schema.
-- Apply as the migration administrator, not as the application login.
BEGIN;
-- Managed project administrators have CREATEROLE, not SUPERUSER. Give only
-- the creating migration administrator access to its new NOLOGIN roles.
SET LOCAL createrole_self_grant='set,inherit';
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='offscript_data_owner') THEN
    CREATE ROLE offscript_data_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='offscript_gateway') THEN
    CREATE ROLE offscript_gateway NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('offscript_data_owner','offscript_gateway') AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Existing Offscript roles have unexpected privileges';
  END IF;
END $$;

CREATE SCHEMA offscript_private AUTHORIZATION offscript_data_owner;
CREATE SCHEMA offscript_api AUTHORIZATION offscript_data_owner;
REVOKE ALL ON SCHEMA offscript_private,offscript_api FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA offscript_api TO offscript_gateway;
GRANT USAGE ON SCHEMA public TO offscript_data_owner,authenticated;
-- PostgreSQL requires the new table owner to have CREATE in the schema at
-- ownership transfer. Remove this bootstrap permission before committing.
GRANT CREATE ON SCHEMA public TO offscript_data_owner;

CREATE TABLE public.offscript_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  eligibility text NOT NULL DEFAULT 'pending' CHECK (eligibility IN ('pending','eligible','ineligible')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_day date
);
CREATE TABLE public.offscript_policy_acceptances (
  user_id uuid NOT NULL REFERENCES public.offscript_accounts(user_id) ON DELETE CASCADE,
  terms_version text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 64),
  privacy_version text NOT NULL CHECK (length(privacy_version) BETWEEN 1 AND 64),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,terms_version,privacy_version)
);
CREATE TABLE public.offscript_usage_daily (
  user_id uuid NOT NULL REFERENCES public.offscript_accounts(user_id) ON DELETE CASCADE,
  day date NOT NULL,
  requests_used integer NOT NULL DEFAULT 0 CHECK (requests_used>=0),
  requests_reserved integer NOT NULL DEFAULT 0 CHECK (requests_reserved>=0),
  deep_used integer NOT NULL DEFAULT 0 CHECK (deep_used>=0),
  deep_reserved integer NOT NULL DEFAULT 0 CHECK (deep_reserved>=0),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used>=0),
  tokens_reserved bigint NOT NULL DEFAULT 0 CHECK (tokens_reserved>=0),
  PRIMARY KEY(user_id,day)
);
CREATE TABLE offscript_private.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  terms_version text NOT NULL DEFAULT '2026-10-17-draft',
  privacy_version text NOT NULL DEFAULT '2026-10-17-draft',
  policies_published boolean NOT NULL DEFAULT false,
  daily_requests integer NOT NULL DEFAULT 10 CHECK (daily_requests BETWEEN 1 AND 10000),
  daily_deep_requests integer NOT NULL DEFAULT 2 CHECK (daily_deep_requests BETWEEN 0 AND 10000),
  daily_tokens bigint NOT NULL DEFAULT 20000 CHECK (daily_tokens BETWEEN 4096 AND 100000000),
  global_concurrency integer NOT NULL DEFAULT 1 CHECK (global_concurrency BETWEEN 1 AND 128)
);
INSERT INTO offscript_private.settings(singleton) VALUES(true);
CREATE TABLE offscript_private.inference_leases (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.offscript_accounts(user_id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('fast','deep')),
  day date NOT NULL,
  reserved_tokens integer NOT NULL DEFAULT 4096 CHECK (reserved_tokens=4096),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','uncertain','finished')),
  outcome text CHECK (outcome IN ('completed','cancelled','failed','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz NOT NULL DEFAULT (now()+interval '330 seconds'),
  finished_at timestamptz
);
CREATE INDEX offscript_live_leases ON offscript_private.inference_leases(user_id) WHERE state IN ('active','uncertain');
CREATE INDEX offscript_finished_leases ON offscript_private.inference_leases(finished_at) WHERE state='finished';

ALTER TABLE public.offscript_accounts OWNER TO offscript_data_owner;
ALTER TABLE public.offscript_policy_acceptances OWNER TO offscript_data_owner;
ALTER TABLE public.offscript_usage_daily OWNER TO offscript_data_owner;
ALTER TABLE offscript_private.settings OWNER TO offscript_data_owner;
ALTER TABLE offscript_private.inference_leases OWNER TO offscript_data_owner;

ALTER TABLE public.offscript_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offscript_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.offscript_policy_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offscript_policy_acceptances FORCE ROW LEVEL SECURITY;
ALTER TABLE public.offscript_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offscript_usage_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE offscript_private.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE offscript_private.settings FORCE ROW LEVEL SECURITY;
ALTER TABLE offscript_private.inference_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE offscript_private.inference_leases FORCE ROW LEVEL SECURITY;

CREATE POLICY own_account_read ON public.offscript_accounts FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
CREATE POLICY own_acceptance_read ON public.offscript_policy_acceptances FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
CREATE POLICY own_usage_read ON public.offscript_usage_daily FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
CREATE POLICY internal_accounts ON public.offscript_accounts TO offscript_data_owner USING(true) WITH CHECK(true);
CREATE POLICY internal_acceptances ON public.offscript_policy_acceptances TO offscript_data_owner USING(true) WITH CHECK(true);
CREATE POLICY internal_usage ON public.offscript_usage_daily TO offscript_data_owner USING(true) WITH CHECK(true);
CREATE POLICY internal_settings ON offscript_private.settings TO offscript_data_owner USING(true) WITH CHECK(true);
CREATE POLICY internal_leases ON offscript_private.inference_leases TO offscript_data_owner USING(true) WITH CHECK(true);
REVOKE ALL ON public.offscript_accounts,public.offscript_policy_acceptances,public.offscript_usage_daily FROM PUBLIC,anon,authenticated,offscript_gateway;
GRANT SELECT ON public.offscript_accounts,public.offscript_policy_acceptances,public.offscript_usage_daily TO authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA offscript_private FROM PUBLIC,anon,authenticated,offscript_gateway;

-- Only the authenticated API gateway calls these functions. It supplies the
-- subject returned by signature/issuer/audience/expiry verification, never body.userId.
CREATE FUNCTION offscript_api.account(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE a public.offscript_accounts; c offscript_private.settings; u public.offscript_usage_daily; accepted boolean;
BEGIN
  IF p_user IS NULL THEN RAISE EXCEPTION 'invalid_account'; END IF;
  INSERT INTO public.offscript_accounts(user_id) VALUES(p_user) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM public.offscript_accounts WHERE user_id=p_user;
  SELECT * INTO c FROM offscript_private.settings WHERE singleton;
  SELECT * INTO u FROM public.offscript_usage_daily WHERE user_id=p_user AND day=CURRENT_DATE;
  SELECT EXISTS(SELECT FROM public.offscript_policy_acceptances WHERE user_id=p_user AND terms_version=c.terms_version AND privacy_version=c.privacy_version) INTO accepted;
  RETURN jsonb_build_object('plan',a.plan,'status',a.status,'eligibility',a.eligibility,
    'policies',jsonb_build_object('termsVersion',c.terms_version,'privacyVersion',c.privacy_version,'published',c.policies_published,'accepted',accepted),
    'usage',jsonb_build_object('requestsRemaining',greatest(0,c.daily_requests-coalesce(u.requests_used,0)-coalesce(u.requests_reserved,0)),
      'deepRemaining',greatest(0,c.daily_deep_requests-coalesce(u.deep_used,0)-coalesce(u.deep_reserved,0)),
      'tokensRemaining',greatest(0,c.daily_tokens-coalesce(u.tokens_used,0)-coalesce(u.tokens_reserved,0))));
END $$;

CREATE FUNCTION offscript_api.accept_policies(p_user uuid,p_terms text,p_privacy text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c offscript_private.settings;
BEGIN
  IF p_user IS NULL THEN RAISE EXCEPTION 'invalid_account'; END IF;
  SELECT * INTO c FROM offscript_private.settings WHERE singleton FOR SHARE;
  IF NOT c.policies_published THEN RAISE EXCEPTION 'policy_unavailable'; END IF;
  IF p_terms IS DISTINCT FROM c.terms_version OR p_privacy IS DISTINCT FROM c.privacy_version THEN RAISE EXCEPTION 'policy_changed'; END IF;
  INSERT INTO public.offscript_accounts(user_id) VALUES(p_user) ON CONFLICT DO NOTHING;
  INSERT INTO public.offscript_policy_acceptances(user_id,terms_version,privacy_version) VALUES(p_user,p_terms,p_privacy) ON CONFLICT DO NOTHING;
  RETURN offscript_api.account(p_user);
END $$;

CREATE FUNCTION offscript_api.reserve_request(p_user uuid,p_request uuid,p_mode text,p_max_tokens integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c offscript_private.settings; a public.offscript_accounts; u public.offscript_usage_daily;
BEGIN
  IF p_user IS NULL OR p_request IS NULL OR p_mode IS NULL OR p_mode NOT IN ('fast','deep') OR p_max_tokens IS NULL OR p_max_tokens NOT IN (256,512,1024) THEN RAISE EXCEPTION 'invalid_request'; END IF;
  -- One lock order serializes admission/settlement across all API replicas.
  SELECT * INTO c FROM offscript_private.settings WHERE singleton FOR UPDATE;
  IF EXISTS(SELECT FROM offscript_private.inference_leases WHERE request_id=p_request) THEN RAISE EXCEPTION 'request_exists'; END IF;
  SELECT * INTO a FROM public.offscript_accounts WHERE user_id=p_user;
  IF NOT FOUND OR a.status<>'active' THEN RAISE EXCEPTION 'account_restricted'; END IF;
  IF a.eligibility<>'eligible' THEN RAISE EXCEPTION 'eligibility_required'; END IF;
  IF NOT c.policies_published THEN RAISE EXCEPTION 'policy_unavailable'; END IF;
  IF NOT EXISTS(SELECT FROM public.offscript_policy_acceptances WHERE user_id=p_user AND terms_version=c.terms_version AND privacy_version=c.privacy_version) THEN RAISE EXCEPTION 'acceptance_required'; END IF;
  INSERT INTO public.offscript_usage_daily(user_id,day) VALUES(p_user,CURRENT_DATE) ON CONFLICT DO NOTHING;
  SELECT * INTO u FROM public.offscript_usage_daily WHERE user_id=p_user AND day=CURRENT_DATE FOR UPDATE;
  IF u.requests_used+u.requests_reserved>=c.daily_requests OR u.tokens_used+u.tokens_reserved+4096>c.daily_tokens OR (p_mode='deep' AND u.deep_used+u.deep_reserved>=c.daily_deep_requests) THEN RAISE EXCEPTION 'quota_exceeded'; END IF;
  IF EXISTS(SELECT FROM offscript_private.inference_leases WHERE user_id=p_user AND state IN ('active','uncertain')) THEN RAISE EXCEPTION 'request_in_progress'; END IF;
  IF (SELECT count(*) FROM offscript_private.inference_leases WHERE state IN ('active','uncertain'))>=c.global_concurrency THEN RAISE EXCEPTION 'capacity_busy'; END IF;
  INSERT INTO offscript_private.inference_leases(request_id,user_id,mode,day) VALUES(p_request,p_user,p_mode,CURRENT_DATE);
  UPDATE public.offscript_usage_daily SET requests_reserved=requests_reserved+1,deep_reserved=deep_reserved+(p_mode='deep')::integer,tokens_reserved=tokens_reserved+4096 WHERE user_id=p_user AND day=CURRENT_DATE;
  RETURN jsonb_build_object('requestId',p_request,'mode',p_mode);
END $$;

CREATE FUNCTION offscript_api.finish_request(p_user uuid,p_request uuid,p_outcome text,p_prompt_tokens integer,p_completion_tokens integer,p_worker_stopped boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE r offscript_private.inference_leases; consumed integer; charged boolean;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('completed','cancelled','failed','rejected') OR p_worker_stopped IS NULL THEN RAISE EXCEPTION 'invalid_request'; END IF;
  PERFORM 1 FROM offscript_private.settings WHERE singleton FOR UPDATE;
  SELECT * INTO r FROM offscript_private.inference_leases WHERE request_id=p_request AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_missing'; END IF;
  IF r.state='finished' THEN RETURN jsonb_build_object('state','finished'); END IF;
  IF NOT p_worker_stopped THEN
    UPDATE offscript_private.inference_leases SET state='uncertain' WHERE request_id=p_request;
    RETURN jsonb_build_object('state','uncertain');
  END IF;
  charged=p_outcome<>'rejected';
  IF p_prompt_tokens IS NULL OR p_completion_tokens IS NULL THEN consumed=r.reserved_tokens;
  ELSE
    IF p_prompt_tokens<0 OR p_completion_tokens<0 OR p_prompt_tokens::bigint+p_completion_tokens::bigint>r.reserved_tokens THEN RAISE EXCEPTION 'invalid_usage'; END IF;
    consumed=p_prompt_tokens+p_completion_tokens;
  END IF;
  UPDATE public.offscript_usage_daily SET requests_reserved=requests_reserved-1,deep_reserved=deep_reserved-(r.mode='deep')::integer,tokens_reserved=tokens_reserved-r.reserved_tokens,
    requests_used=requests_used+charged::integer,deep_used=deep_used+(charged AND r.mode='deep')::integer,tokens_used=tokens_used+CASE WHEN charged THEN consumed ELSE 0 END
    WHERE user_id=p_user AND day=r.day;
  UPDATE offscript_private.inference_leases SET state='finished',outcome=p_outcome,finished_at=now() WHERE request_id=p_request;
  IF p_outcome='completed' THEN UPDATE public.offscript_accounts SET last_active_day=CURRENT_DATE WHERE user_id=p_user; END IF;
  RETURN jsonb_build_object('state','finished');
END $$;

CREATE FUNCTION offscript_api.prune_metadata() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  DELETE FROM offscript_private.inference_leases WHERE state='finished' AND finished_at<now()-interval '24 hours';
  DELETE FROM public.offscript_usage_daily u WHERE day<(now() AT TIME ZONE 'UTC')::date-35 AND NOT EXISTS(SELECT FROM offscript_private.inference_leases l WHERE l.user_id=u.user_id AND l.day=u.day AND l.state IN ('active','uncertain'));
END $$;

ALTER FUNCTION offscript_api.account(uuid) OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.accept_policies(uuid,text,text) OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.reserve_request(uuid,uuid,text,integer) OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.finish_request(uuid,uuid,text,integer,integer,boolean) OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.prune_metadata() OWNER TO offscript_data_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA offscript_api FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA offscript_api TO offscript_gateway;
ALTER DEFAULT PRIVILEGES FOR ROLE offscript_data_owner IN SCHEMA offscript_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMENT ON SCHEMA offscript_api IS 'Private SQL API: verified gateway role only; do not expose through PostgREST.';
COMMENT ON TABLE offscript_private.inference_leases IS 'No prompts/replies; expiry alone never releases uncertain model capacity.';
REVOKE CREATE ON SCHEMA public FROM offscript_data_owner;
COMMIT;
