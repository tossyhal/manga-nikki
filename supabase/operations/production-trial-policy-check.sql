BEGIN READ ONLY;
SET LOCAL default_transaction_read_only=on;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
SELECT pg_catalog.json_build_object(
  'identityOk',current_user='postgres' AND pg_catalog.current_database()='postgres',
  'readOnly',pg_catalog.current_setting('transaction_read_only')='on',
  'policyExists',(SELECT count(*)=1 FROM private.generation_policy WHERE id=1),
  'public80SchemaReady',(EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='private.generation_policy'::regclass AND attname='daily_limit_exempt_owners' AND atttypid='uuid[]'::regtype AND attnotnull AND NOT attisdropped)
    AND (SELECT count(*)=2 FROM pg_catalog.pg_attribute WHERE attrelid='private.generation_policy'::regclass AND attname IN ('global_daily_limit','global_total_limit') AND NOT attnotnull AND NOT attisdropped)),
  'public80Ready',COALESCE((SELECT (NOT p.enabled AND (p.user_daily_limit=1 AND p.global_daily_limit=1 AND p.global_total_limit=1 AND p.budget_micro_usd=1000000 AND p.model_profile_json='{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb) AND pg_catalog.to_jsonb(p)->'daily_limit_exempt_owners'='[]'::jsonb AND (EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='private.generation_policy'::regclass AND attname='daily_limit_exempt_owners' AND atttypid='uuid[]'::regtype AND attnotnull AND NOT attisdropped)
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
    AND (SELECT count(*)=3 FROM private.quota_counters c CROSS JOIN private.reservations r WHERE c.count=1 AND c.committed_micro_usd=1000000 AND ((c.scope='global_total' AND c.subject IS NULL AND c.day_key IS NULL) OR (c.scope='global_day' AND c.subject IS NULL AND c.day_key=r.reserved_day) OR (c.scope='user_day' AND c.subject=r.owner_id AND c.day_key=r.reserved_day))))) FROM private.generation_policy p WHERE id=1),false),
  'public80Prepared',COALESCE((SELECT (p.user_daily_limit=3 AND p.global_daily_limit IS NULL AND p.global_total_limit IS NULL AND p.budget_micro_usd=80000000 AND p.model_profile_json='{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb AND pg_catalog.jsonb_array_length(pg_catalog.to_jsonb(p)->'daily_limit_exempt_owners')=1) FROM private.generation_policy p WHERE id=1),false),
  'cumulativeReservedCount',COALESCE((SELECT count FROM private.quota_counters WHERE scope='global_total'),0),
  'cumulativeReservedMicroUsd',COALESCE((SELECT committed_micro_usd FROM private.quota_counters WHERE scope='global_total'),0),
  'enabled',(SELECT enabled FROM private.generation_policy WHERE id=1),
  'initialPolicy',COALESCE((SELECT NOT enabled AND user_daily_limit=2 AND global_daily_limit=0 AND global_total_limit=0 AND budget_micro_usd=0 AND model_profile_json='{}'::jsonb FROM private.generation_policy WHERE id=1),false),
  'trialPrepared',COALESCE((SELECT user_daily_limit=1 AND global_daily_limit=1 AND global_total_limit=1 AND budget_micro_usd=1000000 AND model_profile_json='{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb FROM private.generation_policy WHERE id=1),false),
  'historyEmpty',NOT EXISTS(SELECT 1 FROM private.quota_counters) AND NOT EXISTS(SELECT 1 FROM private.reservations) AND NOT EXISTS(SELECT 1 FROM public.generations) AND NOT EXISTS(SELECT 1 FROM private.provider_attempts) AND NOT EXISTS(SELECT 1 FROM private.retained_generation_ledger) AND NOT EXISTS(SELECT 1 FROM private.retained_generation_requests) AND NOT EXISTS(SELECT 1 FROM private.retained_provider_attempts),
  'policyTriggerPresent',EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='private.generation_policy'::regclass AND tgname='generation_policy_serialize_update' AND tgfoid='private.lock_generation_policy_update()'::regprocedure AND tgenabled IN ('O','A') AND NOT tgisinternal)
)::text;
ROLLBACK;
