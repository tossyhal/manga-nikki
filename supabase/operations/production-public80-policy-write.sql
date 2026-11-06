BEGIN READ WRITE;
-- TRIAL_POLICY_SETTINGS
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
DO $$
DECLARE
  policy private.generation_policy;
  trial_owner uuid;
BEGIN
  IF current_user <> 'postgres' OR pg_catalog.current_database() <> 'postgres'
    OR pg_catalog.current_setting('manga_nikki.trial_policy_operation',true) IS DISTINCT FROM 'activate-public80' THEN
    RAISE EXCEPTION 'TRIAL_POLICY_CONTEXT_INVALID';
  END IF;
  IF pg_catalog.current_setting('manga_nikki.trial_provider_cost_verified',true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'TRIAL_PROVIDER_COST_NOT_VERIFIED';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(20261103,10001);
  SELECT * INTO STRICT policy FROM private.generation_policy WHERE id=1 FOR UPDATE;
  IF NOT COALESCE((SELECT (NOT p.enabled AND (p.user_daily_limit=1 AND p.global_daily_limit=1 AND p.global_total_limit=1 AND p.budget_micro_usd=1000000 AND p.model_profile_json='{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb) AND pg_catalog.to_jsonb(p)->'daily_limit_exempt_owners'='[]'::jsonb AND (EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='private.generation_policy'::regclass AND attname='daily_limit_exempt_owners' AND atttypid='uuid[]'::regtype AND attnotnull AND NOT attisdropped)
    AND (SELECT count(*)=2 FROM pg_catalog.pg_attribute WHERE attrelid='private.generation_policy'::regclass AND attname IN ('global_daily_limit','global_total_limit') AND NOT attnotnull AND NOT attisdropped)) AND (EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='private.generation_policy'::regclass AND tgname='generation_policy_serialize_update' AND tgfoid='private.lock_generation_policy_update()'::regprocedure AND tgenabled IN ('O','A') AND NOT tgisinternal)) AND ((SELECT count(*)=1 FROM public.generations)
    AND (SELECT count(*)=1 FROM public.generations WHERE status='succeeded' AND NOT is_mock AND model_profile_snapshot=p.model_profile_json)
    AND (SELECT count(*)=1 FROM private.reservations)
    AND (SELECT count(*)=1 FROM private.reservations r JOIN public.generations g ON g.id=r.generation_id AND g.owner_id=r.owner_id WHERE g.status='succeeded' AND r.state='consumed' AND r.max_cost_micro_usd=1000000)
    AND (SELECT count(*)=5 FROM private.provider_attempts)
    AND (SELECT count(*)=5 FROM private.provider_attempts a JOIN public.generations g ON g.id=a.generation_id AND g.owner_id=a.owner_id WHERE g.status='succeeded' AND a.state='succeeded' AND NOT a.is_mock AND a.finished_at IS NOT NULL AND ((a.stage='script' AND a.call_index=1) OR (a.stage='images' AND a.call_index BETWEEN 1 AND 4)))
    AND NOT EXISTS(SELECT 1 FROM private.comic_save_tasks)
    AND NOT EXISTS(SELECT 1 FROM private.retained_generation_ledger)
    AND NOT EXISTS(SELECT 1 FROM private.retained_generation_requests)
    AND NOT EXISTS(SELECT 1 FROM private.retained_provider_attempts)
    AND (SELECT count(*)=3 FROM private.quota_counters)
    AND (SELECT count(*)=3 FROM private.quota_counters c CROSS JOIN private.reservations r WHERE c.count=1 AND c.committed_micro_usd=1000000 AND ((c.scope='global_total' AND c.subject IS NULL AND c.day_key IS NULL) OR (c.scope='global_day' AND c.subject IS NULL AND c.day_key=r.reserved_day) OR (c.scope='user_day' AND c.subject=r.owner_id AND c.day_key=r.reserved_day))))) FROM private.generation_policy p WHERE id=1),false) THEN
    RAISE EXCEPTION 'TRIAL_POLICY_STATE_INVALID';
  END IF;
  IF NOT private.is_valid_openai_generation_profile(policy.model_profile_json) THEN
    RAISE EXCEPTION 'TRIAL_PROFILE_INVALID';
  END IF;
  SELECT owner_id INTO STRICT trial_owner FROM public.generations WHERE status='succeeded';
  UPDATE private.generation_policy
    SET enabled=true,user_daily_limit=3,global_daily_limit=NULL,global_total_limit=NULL,
      budget_micro_usd=80000000,daily_limit_exempt_owners=ARRAY[trial_owner]
    WHERE id=1;
END;
$$;
COMMIT;
SELECT 'TRIAL_POLICY_TRANSACTION_COMMITTED';
