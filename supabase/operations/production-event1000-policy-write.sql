BEGIN READ WRITE;
-- TRIAL_POLICY_SETTINGS
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
DO $$
DECLARE
  policy private.generation_policy;
  event_profile constant jsonb := '{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb;
BEGIN
  IF current_user <> 'postgres' OR pg_catalog.current_database() <> 'postgres'
    OR pg_catalog.current_setting('manga_nikki.trial_policy_operation',true) IS DISTINCT FROM 'activate-event1000' THEN
    RAISE EXCEPTION 'TRIAL_POLICY_CONTEXT_INVALID';
  END IF;
  IF pg_catalog.current_setting('manga_nikki.trial_provider_cost_verified',true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'TRIAL_PROVIDER_COST_NOT_VERIFIED';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(20261103,10001);
  SELECT * INTO STRICT policy FROM private.generation_policy WHERE id=1 FOR UPDATE;
  IF policy.enabled IS DISTINCT FROM true
    OR policy.user_daily_limit IS DISTINCT FROM 3
    OR policy.global_daily_limit IS NOT NULL
    OR policy.global_total_limit IS DISTINCT FROM 250
    OR policy.budget_micro_usd IS DISTINCT FROM 250000000
    OR policy.model_profile_json IS DISTINCT FROM event_profile
    OR COALESCE(pg_catalog.array_length(policy.daily_limit_exempt_owners,1),0) <> 1
    OR NOT EXISTS(
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid='private.generation_policy'::regclass
        AND attname='daily_limit_exempt_owners' AND atttypid='uuid[]'::regtype
        AND attnotnull AND NOT attisdropped
    )
    OR (SELECT count(*)=2 FROM pg_catalog.pg_attribute
      WHERE attrelid='private.generation_policy'::regclass
        AND attname IN ('global_daily_limit','global_total_limit')
        AND NOT attnotnull AND NOT attisdropped) IS NOT TRUE
    OR NOT EXISTS(
      SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='private.generation_policy'::regclass
        AND tgname='generation_policy_serialize_update'
        AND tgfoid='private.lock_generation_policy_update()'::regprocedure
        AND tgenabled IN ('O','A') AND NOT tgisinternal
    ) THEN
    RAISE EXCEPTION 'TRIAL_POLICY_STATE_INVALID';
  END IF;
  IF private.is_valid_openai_generation_profile(policy.model_profile_json) IS NOT TRUE THEN
    RAISE EXCEPTION 'TRIAL_PROFILE_INVALID';
  END IF;
  UPDATE private.generation_policy
    SET global_total_limit=1000,budget_micro_usd=1000000000
    WHERE id=1;
END;
$$;
COMMIT;
SELECT 'TRIAL_POLICY_TRANSACTION_COMMITTED';
