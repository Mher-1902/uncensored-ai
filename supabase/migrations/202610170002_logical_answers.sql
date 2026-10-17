-- Content-free accounting for one logical answer across bounded worker segments.
-- The foundation is already applied; never edit or re-run migration 001.
BEGIN;

CREATE TABLE offscript_private.answers (
  answer_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.offscript_accounts(user_id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('fast','deep')),
  day date NOT NULL,
  reserved_tokens integer NOT NULL DEFAULT 4096 CHECK (reserved_tokens=4096),
  consumed_tokens integer NOT NULL DEFAULT 0 CHECK (consumed_tokens BETWEEN 0 AND 4096),
  segment_count integer NOT NULL DEFAULT 1 CHECK (segment_count BETWEEN 1 AND 16),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','waiting','uncertain','finished')),
  outcome text CHECK (outcome IN ('completed','cancelled','failed','rejected','expired','budget')),
  last_request_id uuid NOT NULL,
  receipt uuid,
  handoff_deadline timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((state='waiting')=(receipt IS NOT NULL AND handoff_deadline IS NOT NULL))
);
CREATE TABLE offscript_private.answer_segments (
  request_id uuid PRIMARY KEY,
  answer_id uuid NOT NULL REFERENCES offscript_private.answers(answer_id) ON DELETE CASCADE,
  worker_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 16),
  output_allowance integer NOT NULL CHECK (output_allowance BETWEEN 1 AND 1280),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','uncertain','finished')),
  outcome text CHECK (outcome IN ('completed','cancelled','failed','rejected')),
  finish_reason text CHECK (finish_reason IN ('stop','length')),
  prompt_tokens integer CHECK (prompt_tokens BETWEEN 0 AND 4096),
  completion_tokens integer CHECK (completion_tokens BETWEEN 0 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz NOT NULL DEFAULT (now()+interval '330 seconds'),
  finished_at timestamptz,
  UNIQUE(answer_id,sequence)
);
CREATE INDEX offscript_open_answers ON offscript_private.answers(user_id) WHERE state<>'finished';
CREATE INDEX offscript_waiting_answers ON offscript_private.answers(handoff_deadline) WHERE state='waiting';
CREATE INDEX offscript_closed_answers ON offscript_private.answers(finished_at) WHERE state='finished';
ALTER TABLE offscript_private.answers OWNER TO offscript_data_owner;
ALTER TABLE offscript_private.answer_segments OWNER TO offscript_data_owner;
ALTER TABLE offscript_private.answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE offscript_private.answers FORCE ROW LEVEL SECURITY;
ALTER TABLE offscript_private.answer_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE offscript_private.answer_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY internal_answers ON offscript_private.answers TO offscript_data_owner USING(true) WITH CHECK(true);
CREATE POLICY internal_segments ON offscript_private.answer_segments TO offscript_data_owner USING(true) WITH CHECK(true);
REVOKE ALL ON offscript_private.answers,offscript_private.answer_segments FROM PUBLIC,anon,authenticated,offscript_gateway;

-- Caller holds the settings/admission lock. This helper is not a gateway API.
CREATE FUNCTION offscript_private.close_answer(p_answer uuid,p_outcome text,p_charged boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a offscript_private.answers;
BEGIN
  SELECT * INTO a FROM offscript_private.answers WHERE answer_id=p_answer FOR UPDATE;
  IF NOT FOUND OR a.state='finished' THEN RETURN; END IF;
  UPDATE public.offscript_usage_daily SET
    requests_reserved=requests_reserved-1,
    deep_reserved=deep_reserved-(a.mode='deep')::integer,
    tokens_reserved=tokens_reserved-a.reserved_tokens,
    requests_used=requests_used+p_charged::integer,
    deep_used=deep_used+(p_charged AND a.mode='deep')::integer,
    tokens_used=tokens_used+CASE WHEN p_charged THEN a.consumed_tokens ELSE 0 END
  WHERE user_id=a.user_id AND day=a.day;
  UPDATE offscript_private.answers SET state='finished',outcome=p_outcome,receipt=NULL,handoff_deadline=NULL,finished_at=now() WHERE answer_id=p_answer;
  IF p_outcome='completed' THEN UPDATE public.offscript_accounts SET last_active_day=(now() AT TIME ZONE 'UTC')::date WHERE user_id=a.user_id; END IF;
END $$;

CREATE FUNCTION offscript_api.expire_answer_handoffs() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a offscript_private.answers; expired integer:=0;
BEGIN
  PERFORM 1 FROM offscript_private.settings WHERE singleton FOR UPDATE;
  FOR a IN SELECT * FROM offscript_private.answers WHERE state='waiting' AND handoff_deadline<=now() FOR UPDATE LOOP
    -- Waiting is entered only after matching worker-stop proof and valid usage.
    PERFORM offscript_private.close_answer(a.answer_id,'expired',true);
    expired=expired+1;
  END LOOP;
  RETURN jsonb_build_object('expired',expired);
END $$;

CREATE FUNCTION offscript_api.start_answer(p_user uuid,p_answer uuid,p_request uuid,p_worker uuid,p_mode text,p_max_tokens integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c offscript_private.settings; a public.offscript_accounts; u public.offscript_usage_daily;
BEGIN
  IF p_user IS NULL OR p_answer IS NULL OR p_request IS NULL OR p_worker IS NULL OR p_mode IS NULL OR p_mode NOT IN ('fast','deep') OR p_max_tokens IS NULL OR p_max_tokens NOT BETWEEN 1 AND 1024 THEN RAISE EXCEPTION 'invalid_request'; END IF;
  PERFORM offscript_api.expire_answer_handoffs();
  SELECT * INTO c FROM offscript_private.settings WHERE singleton FOR UPDATE;
  IF EXISTS(SELECT FROM offscript_private.answers WHERE answer_id=p_answer) OR EXISTS(SELECT FROM offscript_private.answer_segments WHERE request_id=p_request) THEN RAISE EXCEPTION 'request_exists'; END IF;
  SELECT * INTO a FROM public.offscript_accounts WHERE user_id=p_user;
  IF NOT FOUND OR a.status<>'active' THEN RAISE EXCEPTION 'account_restricted'; END IF;
  IF a.eligibility<>'eligible' THEN RAISE EXCEPTION 'eligibility_required'; END IF;
  IF NOT c.policies_published THEN RAISE EXCEPTION 'policy_unavailable'; END IF;
  IF NOT EXISTS(SELECT FROM public.offscript_policy_acceptances WHERE user_id=p_user AND terms_version=c.terms_version AND privacy_version=c.privacy_version) THEN RAISE EXCEPTION 'acceptance_required'; END IF;
  INSERT INTO public.offscript_usage_daily(user_id,day) VALUES(p_user,CURRENT_DATE) ON CONFLICT DO NOTHING;
  SELECT * INTO u FROM public.offscript_usage_daily WHERE user_id=p_user AND day=CURRENT_DATE FOR UPDATE;
  IF u.requests_used+u.requests_reserved>=c.daily_requests OR u.tokens_used+u.tokens_reserved+4096>c.daily_tokens OR (p_mode='deep' AND u.deep_used+u.deep_reserved>=c.daily_deep_requests) THEN RAISE EXCEPTION 'quota_exceeded'; END IF;
  IF EXISTS(SELECT FROM offscript_private.answers WHERE user_id=p_user AND state<>'finished') OR EXISTS(SELECT FROM offscript_private.inference_leases WHERE user_id=p_user AND state IN ('active','uncertain')) THEN RAISE EXCEPTION 'request_in_progress'; END IF;
  IF (SELECT count(*) FROM offscript_private.answers WHERE state<>'finished')+(SELECT count(*) FROM offscript_private.inference_leases WHERE state IN ('active','uncertain'))>=c.global_concurrency THEN RAISE EXCEPTION 'capacity_busy'; END IF;
  INSERT INTO offscript_private.answers(answer_id,user_id,mode,day,last_request_id) VALUES(p_answer,p_user,p_mode,CURRENT_DATE,p_request);
  -- The pinned engine adds up to 256 thinking tokens to the first Deep segment.
  -- Its usage counts those tokens; they belong in the same answer reservation.
  INSERT INTO offscript_private.answer_segments(request_id,answer_id,worker_id,sequence,output_allowance) VALUES(p_request,p_answer,p_worker,1,p_max_tokens+CASE WHEN p_mode='deep' THEN 256 ELSE 0 END);
  UPDATE public.offscript_usage_daily SET requests_reserved=requests_reserved+1,deep_reserved=deep_reserved+(p_mode='deep')::integer,tokens_reserved=tokens_reserved+4096 WHERE user_id=p_user AND day=CURRENT_DATE;
  RETURN jsonb_build_object('state','active','answerId',p_answer,'requestId',p_request,'maxTokens',p_max_tokens);
END $$;

CREATE FUNCTION offscript_api.continue_answer(p_user uuid,p_answer uuid,p_receipt uuid,p_request uuid,p_worker uuid,p_max_tokens integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE a offscript_private.answers; c offscript_private.settings; account public.offscript_accounts; allowance integer;
BEGIN
  IF p_user IS NULL OR p_answer IS NULL OR p_receipt IS NULL OR p_request IS NULL OR p_worker IS NULL OR p_max_tokens IS NULL OR p_max_tokens NOT BETWEEN 1 AND 1024 THEN RAISE EXCEPTION 'invalid_request'; END IF;
  SELECT * INTO c FROM offscript_private.settings WHERE singleton FOR UPDATE;
  SELECT * INTO a FROM offscript_private.answers WHERE answer_id=p_answer AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'answer_missing'; END IF;
  IF a.state<>'waiting' OR a.receipt<>p_receipt OR a.cancel_requested THEN RAISE EXCEPTION 'continuation_invalid'; END IF;
  IF a.handoff_deadline<=now() THEN
    PERFORM offscript_private.close_answer(p_answer,'expired',true);
    RETURN jsonb_build_object('state','finished','outcome','expired');
  END IF;
  -- Eligibility and current policy consent are rechecked on every segment.
  SELECT * INTO account FROM public.offscript_accounts WHERE user_id=p_user;
  IF account.status<>'active' THEN RAISE EXCEPTION 'account_restricted'; END IF;
  IF account.eligibility<>'eligible' THEN RAISE EXCEPTION 'eligibility_required'; END IF;
  IF NOT c.policies_published THEN RAISE EXCEPTION 'policy_unavailable'; END IF;
  IF NOT EXISTS(SELECT FROM public.offscript_policy_acceptances WHERE user_id=p_user AND terms_version=c.terms_version AND privacy_version=c.privacy_version) THEN RAISE EXCEPTION 'acceptance_required'; END IF;
  IF EXISTS(SELECT FROM offscript_private.answer_segments WHERE request_id=p_request) THEN RAISE EXCEPTION 'request_exists'; END IF;
  allowance=least(p_max_tokens,a.reserved_tokens-a.consumed_tokens);
  IF allowance<32 OR a.segment_count>=16 THEN RAISE EXCEPTION 'continuation_invalid'; END IF;
  INSERT INTO offscript_private.answer_segments(request_id,answer_id,worker_id,sequence,output_allowance) VALUES(p_request,p_answer,p_worker,a.segment_count+1,allowance);
  UPDATE offscript_private.answers SET state='active',segment_count=segment_count+1,last_request_id=p_request,receipt=NULL,handoff_deadline=NULL WHERE answer_id=p_answer;
  RETURN jsonb_build_object('state','active','answerId',p_answer,'requestId',p_request,'maxTokens',allowance);
END $$;

CREATE FUNCTION offscript_api.finish_answer_segment(p_user uuid,p_answer uuid,p_request uuid,p_worker uuid,p_outcome text,p_prompt_tokens integer,p_completion_tokens integer,p_finish_reason text,p_visible boolean,p_worker_stopped boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE a offscript_private.answers; s offscript_private.answer_segments; consumed integer; valid_usage boolean; terminal text; next_receipt uuid;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('completed','cancelled','failed','rejected') OR p_worker_stopped IS NULL OR p_visible IS NULL OR (p_finish_reason IS NOT NULL AND p_finish_reason NOT IN ('stop','length')) THEN RAISE EXCEPTION 'invalid_request'; END IF;
  PERFORM 1 FROM offscript_private.settings WHERE singleton FOR UPDATE;
  SELECT * INTO a FROM offscript_private.answers WHERE answer_id=p_answer AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'answer_missing'; END IF;
  SELECT * INTO s FROM offscript_private.answer_segments WHERE request_id=p_request AND answer_id=p_answer AND worker_id=p_worker FOR UPDATE;
  IF NOT FOUND OR a.last_request_id<>p_request THEN RAISE EXCEPTION 'worker_mismatch'; END IF;
  IF s.state='finished' THEN
    RETURN jsonb_build_object('state',a.state,'outcome',a.outcome,'answerId',p_answer,'receipt',a.receipt);
  END IF;
  IF NOT p_worker_stopped THEN
    UPDATE offscript_private.answer_segments SET state='uncertain' WHERE request_id=p_request;
    UPDATE offscript_private.answers SET state='uncertain' WHERE answer_id=p_answer;
    RETURN jsonb_build_object('state','uncertain');
  END IF;
  valid_usage=p_prompt_tokens IS NOT NULL AND p_completion_tokens IS NOT NULL
    AND p_prompt_tokens BETWEEN 0 AND 4096 AND p_completion_tokens BETWEEN 0 AND s.output_allowance
    AND p_prompt_tokens::bigint+p_completion_tokens::bigint<=4096;
  consumed=CASE WHEN valid_usage THEN a.consumed_tokens+p_completion_tokens+CASE WHEN s.sequence=1 THEN p_prompt_tokens ELSE 0 END ELSE a.reserved_tokens END;
  IF consumed>a.reserved_tokens THEN RAISE EXCEPTION 'invalid_usage'; END IF;
  -- Rejected means the worker confirms it never started. A later segment's
  -- rejection still charges the earlier work in this logical answer.
  IF p_outcome='rejected' THEN consumed=a.consumed_tokens; END IF;
  UPDATE offscript_private.answer_segments SET state='finished',outcome=p_outcome,finish_reason=p_finish_reason,
    prompt_tokens=CASE WHEN valid_usage THEN p_prompt_tokens END,
    completion_tokens=CASE WHEN valid_usage THEN p_completion_tokens END,finished_at=now() WHERE request_id=p_request;
  UPDATE offscript_private.answers SET consumed_tokens=consumed WHERE answer_id=p_answer;
  IF NOT a.cancel_requested AND p_outcome='completed' AND p_finish_reason='length' AND p_visible AND valid_usage AND p_completion_tokens>0 AND consumed<=a.reserved_tokens-32 AND a.segment_count<16 THEN
    next_receipt=gen_random_uuid();
    UPDATE offscript_private.answers SET state='waiting',receipt=next_receipt,handoff_deadline=now()+interval '30 seconds' WHERE answer_id=p_answer;
    RETURN jsonb_build_object('state','waiting','answerId',p_answer,'receipt',next_receipt);
  END IF;
  terminal=CASE WHEN a.cancel_requested THEN 'cancelled' WHEN p_outcome='completed' AND p_finish_reason='length' THEN 'budget' WHEN p_outcome='completed' AND (NOT valid_usage OR p_finish_reason IS DISTINCT FROM 'stop' OR NOT p_visible) THEN 'failed' ELSE p_outcome END;
  PERFORM offscript_private.close_answer(p_answer,terminal,NOT (p_outcome='rejected' AND s.sequence=1));
  RETURN jsonb_build_object('state','finished','outcome',terminal,'answerId',p_answer);
END $$;

CREATE FUNCTION offscript_api.cancel_answer(p_user uuid,p_answer uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a offscript_private.answers; s offscript_private.answer_segments;
BEGIN
  PERFORM 1 FROM offscript_private.settings WHERE singleton FOR UPDATE;
  SELECT * INTO a FROM offscript_private.answers WHERE answer_id=p_answer AND user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'answer_missing'; END IF;
  IF a.state='finished' THEN RETURN jsonb_build_object('state','finished'); END IF;
  UPDATE offscript_private.answers SET cancel_requested=true WHERE answer_id=p_answer;
  IF a.state='waiting' THEN
    PERFORM offscript_private.close_answer(p_answer,'cancelled',true);
    RETURN jsonb_build_object('state','finished');
  END IF;
  SELECT * INTO s FROM offscript_private.answer_segments WHERE request_id=a.last_request_id;
  RETURN jsonb_build_object('state',a.state,'requestId',s.request_id,'workerId',s.worker_id);
END $$;

-- Even an administrative Auth deletion must first stop/reconcile computation.
-- Otherwise ON DELETE CASCADE could remove an occupied global slot too early.
CREATE FUNCTION offscript_private.guard_account_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM offscript_private.settings WHERE singleton FOR UPDATE;
  IF EXISTS(SELECT FROM offscript_private.answers WHERE user_id=OLD.user_id AND state<>'finished')
    OR EXISTS(SELECT FROM offscript_private.inference_leases WHERE user_id=OLD.user_id AND state IN ('active','uncertain')) THEN
    RAISE EXCEPTION 'account_in_progress';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER offscript_account_delete_guard BEFORE DELETE ON public.offscript_accounts FOR EACH ROW EXECUTE FUNCTION offscript_private.guard_account_delete();

-- Finished answers cascade their worker receipts. Uncertain computation and
-- legacy uncertain leases are never pruned or freed just because time passed.
CREATE OR REPLACE FUNCTION offscript_api.prune_metadata() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM offscript_api.expire_answer_handoffs();
  DELETE FROM offscript_private.answers WHERE state='finished' AND finished_at<now()-interval '24 hours';
  DELETE FROM offscript_private.inference_leases WHERE state='finished' AND finished_at<now()-interval '24 hours';
  DELETE FROM public.offscript_usage_daily u WHERE day<(now() AT TIME ZONE 'UTC')::date-35
    AND NOT EXISTS(SELECT FROM offscript_private.answers a WHERE a.user_id=u.user_id AND a.day=u.day AND a.state<>'finished')
    AND NOT EXISTS(SELECT FROM offscript_private.inference_leases l WHERE l.user_id=u.user_id AND l.day=u.day AND l.state IN ('active','uncertain'));
END $$;

ALTER FUNCTION offscript_private.close_answer(uuid,text,boolean) OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_private.guard_account_delete() OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.expire_answer_handoffs() OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.start_answer(uuid,uuid,uuid,uuid,text,integer) OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.continue_answer(uuid,uuid,uuid,uuid,uuid,integer) OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.finish_answer_segment(uuid,uuid,uuid,uuid,text,integer,integer,text,boolean,boolean) OWNER TO offscript_data_owner;
ALTER FUNCTION offscript_api.cancel_answer(uuid,uuid) OWNER TO offscript_data_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA offscript_private FROM PUBLIC,anon,authenticated,offscript_gateway;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA offscript_api FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA offscript_api TO offscript_gateway;
-- Disable the legacy per-worker admission path after the answer ledger exists.
REVOKE EXECUTE ON FUNCTION offscript_api.reserve_request(uuid,uuid,text,integer),offscript_api.finish_request(uuid,uuid,text,integer,integer,boolean) FROM offscript_gateway;
COMMENT ON TABLE offscript_private.answers IS 'One content-free answer allowance across at most 16 segments; no conversation storage.';
COMMENT ON TABLE offscript_private.answer_segments IS 'Worker cleanup/usage metadata only; gateway changes are not proof of model stop.';
COMMIT;
