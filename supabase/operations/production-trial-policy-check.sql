BEGIN READ ONLY;
SET LOCAL default_transaction_read_only=on;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
SELECT pg_catalog.json_build_object(
  'identityOk',current_user='postgres' AND pg_catalog.current_database()='postgres',
  'readOnly',pg_catalog.current_setting('transaction_read_only')='on',
  'policyExists',(SELECT count(*)=1 FROM private.generation_policy WHERE id=1),
  'enabled',(SELECT enabled FROM private.generation_policy WHERE id=1),
  'initialPolicy',(SELECT NOT enabled AND user_daily_limit=2 AND global_daily_limit=0 AND global_total_limit=0 AND budget_micro_usd=0 AND model_profile_json='{}'::jsonb FROM private.generation_policy WHERE id=1),
  'trialPrepared',(SELECT user_daily_limit=1 AND global_daily_limit=1 AND global_total_limit=1 AND budget_micro_usd=1000000 AND model_profile_json='{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb FROM private.generation_policy WHERE id=1),
  'historyEmpty',NOT EXISTS(SELECT 1 FROM private.quota_counters) AND NOT EXISTS(SELECT 1 FROM private.reservations) AND NOT EXISTS(SELECT 1 FROM public.generations) AND NOT EXISTS(SELECT 1 FROM private.provider_attempts) AND NOT EXISTS(SELECT 1 FROM private.retained_generation_ledger) AND NOT EXISTS(SELECT 1 FROM private.retained_generation_requests) AND NOT EXISTS(SELECT 1 FROM private.retained_provider_attempts),
  'policyTriggerPresent',EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='private.generation_policy'::regclass AND tgname='generation_policy_serialize_update' AND tgfoid='private.lock_generation_policy_update()'::regprocedure AND tgenabled IN ('O','A') AND NOT tgisinternal)
)::text;
ROLLBACK;
