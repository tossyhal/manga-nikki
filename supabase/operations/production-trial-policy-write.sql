BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
DO $$
DECLARE
  operation text := pg_catalog.current_setting('manga_nikki.trial_policy_operation',true);
  policy private.generation_policy;
  initial_policy boolean;
  trial_profile constant jsonb := '{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb;
BEGIN
  IF current_user <> 'postgres' OR pg_catalog.current_database() <> 'postgres'
    OR operation IS NULL OR operation NOT IN ('prepare','enable','stop') THEN
    RAISE EXCEPTION 'TRIAL_POLICY_CONTEXT_INVALID';
  END IF;
  IF operation='enable' AND pg_catalog.current_setting('manga_nikki.trial_provider_cost_verified',true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'TRIAL_PROVIDER_COST_NOT_VERIFIED';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(20261103,10001);
  SELECT * INTO STRICT policy FROM private.generation_policy WHERE id=1 FOR UPDATE;
  IF operation='stop' THEN
    UPDATE private.generation_policy SET enabled=false WHERE id=1;
    RETURN;
  END IF;
  IF policy.enabled OR NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='private.generation_policy'::regclass
    AND tgname='generation_policy_serialize_update' AND tgfoid='private.lock_generation_policy_update()'::regprocedure
    AND tgenabled IN ('O','A') AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'TRIAL_POLICY_STATE_INVALID';
  END IF;
  IF EXISTS(SELECT 1 FROM private.quota_counters) OR EXISTS(SELECT 1 FROM private.reservations)
    OR EXISTS(SELECT 1 FROM public.generations) OR EXISTS(SELECT 1 FROM private.provider_attempts)
    OR EXISTS(SELECT 1 FROM private.retained_generation_ledger) OR EXISTS(SELECT 1 FROM private.retained_generation_requests)
    OR EXISTS(SELECT 1 FROM private.retained_provider_attempts) THEN
    RAISE EXCEPTION 'TRIAL_POLICY_HISTORY_NOT_EMPTY';
  END IF;
  initial_policy := policy.user_daily_limit=2 AND policy.global_daily_limit=0 AND policy.global_total_limit=0
    AND policy.budget_micro_usd=0 AND policy.model_profile_json='{}'::jsonb;
  IF NOT (policy.user_daily_limit=1 AND policy.global_daily_limit=1 AND policy.global_total_limit=1
    AND policy.budget_micro_usd=1000000 AND policy.model_profile_json=trial_profile) THEN
    IF operation <> 'prepare' OR NOT initial_policy THEN
      RAISE EXCEPTION 'TRIAL_POLICY_STATE_INVALID';
    END IF;
  END IF;
  IF NOT private.is_valid_openai_generation_profile(trial_profile) THEN
    RAISE EXCEPTION 'TRIAL_PROFILE_INVALID';
  END IF;
  UPDATE private.generation_policy
    SET enabled=(operation='enable'),user_daily_limit=1,global_daily_limit=1,global_total_limit=1,
      budget_micro_usd=1000000,model_profile_json=trial_profile
    WHERE id=1;
END;
$$;
COMMIT;
SELECT 'TRIAL_POLICY_TRANSACTION_COMMITTED';
