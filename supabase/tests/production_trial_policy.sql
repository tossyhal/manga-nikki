-- 既存bootstrapとmigrationだけを適用した、廃棄する専用PostgreSQLクラスタで実行する。
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_user <> 'postgres' OR pg_catalog.current_database() <> 'postgres'
    OR EXISTS(SELECT 1 FROM public.entries) OR EXISTS(SELECT 1 FROM public.generations)
    OR EXISTS(SELECT 1 FROM private.quota_counters)
    OR NOT EXISTS(SELECT 1 FROM private.generation_policy WHERE id=1 AND NOT enabled AND model_profile_json='{}'::jsonb) THEN
    RAISE EXCEPTION 'EMPTY_ISOLATED_TRIAL_TEST_DATABASE_REQUIRED';
  END IF;
END $$;
SET manga_nikki.trial_policy_operation='prepare';
\ir ../operations/production-trial-policy-write.sql
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.generation_policy WHERE NOT enabled AND user_daily_limit=1 AND global_daily_limit=1 AND global_total_limit=1 AND budget_micro_usd=1000000 AND model_profile_json->>'max_cost_micro_usd'='1000000' AND private.is_valid_openai_generation_profile(model_profile_json)) THEN
    RAISE EXCEPTION 'PREPARE_DID_NOT_KEEP_TRIAL_DISABLED';
  END IF;
END $$;
\ir ../operations/production-trial-policy-write.sql

-- 費用未検証のenableはSQL境界でも拒否し、停止を保つ。
SET manga_nikki.trial_policy_operation='enable';
\set ON_ERROR_STOP off
\ir ../operations/production-trial-policy-write.sql
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF (SELECT enabled FROM private.generation_policy WHERE id=1) THEN RAISE EXCEPTION 'UNVERIFIED_ENABLE_ALLOWED'; END IF;
END $$;
SET manga_nikki.trial_provider_cost_verified='true';
\ir ../operations/production-trial-policy-write.sql
DO $$ BEGIN
  IF NOT (SELECT enabled FROM private.generation_policy WHERE id=1) THEN RAISE EXCEPTION 'VERIFIED_ENABLE_REJECTED'; END IF;
END $$;

-- 有効中のprepareは枠を作り直さない。
SET manga_nikki.trial_policy_operation='prepare';
\set ON_ERROR_STOP off
\ir ../operations/production-trial-policy-write.sql
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT (SELECT enabled FROM private.generation_policy WHERE id=1) THEN RAISE EXCEPTION 'PREPARE_CHANGED_ENABLED_POLICY'; END IF;
END $$;
SET manga_nikki.trial_policy_operation='stop';
\ir ../operations/production-trial-policy-write.sql

-- 0件へ戻ったcounter行も履歴として検出し、再prepare/re-enableを拒否する。
INSERT INTO private.quota_counters(scope,subject,day_key,count,committed_micro_usd) VALUES('global_total',null,null,0,0);
SET manga_nikki.trial_policy_operation='prepare';
\set ON_ERROR_STOP off
\ir ../operations/production-trial-policy-write.sql
SET manga_nikki.trial_policy_operation='enable';
\ir ../operations/production-trial-policy-write.sql
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF (SELECT enabled FROM private.generation_policy WHERE id=1)
    OR (SELECT count(*) FROM private.quota_counters) <> 1 THEN
    RAISE EXCEPTION 'HISTORY_WAS_RESET_OR_REENABLED';
  END IF;
END $$;
SET manga_nikki.trial_policy_operation='stop';
\ir ../operations/production-trial-policy-write.sql
DO $$ BEGIN
  IF (SELECT enabled FROM private.generation_policy WHERE id=1)
    OR NOT EXISTS(SELECT 1 FROM private.quota_counters WHERE scope='global_total' AND count=0 AND committed_micro_usd=0)
    OR NOT EXISTS(SELECT 1 FROM private.generation_policy WHERE global_total_limit=1 AND budget_micro_usd=1000000) THEN
    RAISE EXCEPTION 'STOP_CHANGED_LEDGER_OR_LIMITS';
  END IF;
END $$;
\echo TRIAL_POLICY_FIXTURE_PASSED
