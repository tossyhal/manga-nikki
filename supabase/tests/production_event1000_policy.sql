-- test-db.mjsが固定operation本文を注入する。廃棄する専用PostgreSQLクラスタで実行する。
\set ON_ERROR_STOP on
SET ROLE postgres;
CREATE OR REPLACE FUNCTION test.assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '検証失敗: %',label; END IF;
END;
$$;
CREATE OR REPLACE FUNCTION test.reject_event1000(label text, expected_error text DEFAULT 'TRIAL_POLICY_STATE_INVALID') RETURNS void LANGUAGE plpgsql AS $$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN
    PERFORM pg_temp.activate_event1000();
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> expected_error THEN RAISE; END IF;
    rejected:=true;
  END;
  PERFORM test.assert(rejected,label);
END;
$$;
CREATE OR REPLACE FUNCTION test.apply_event1000_stop() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.apply_trial_policy_stop();
END;
$$;

UPDATE private.generation_policy
SET model_profile_json='{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb,
  enabled=true,user_daily_limit=3,global_daily_limit=NULL,global_total_limit=250,
  budget_micro_usd=250000000,daily_limit_exempt_owners=ARRAY['fd100000-0000-4000-8000-000000000002'::uuid]
WHERE id=1;
INSERT INTO auth.users(id) VALUES ('fd100000-0000-4000-8000-000000000002');
INSERT INTO public.entries(id,owner_id,create_request_id,create_request_hash,diary_date,body,consent_version)
VALUES
  ('fd200000-0000-4000-8000-000000000003','fd100000-0000-4000-8000-000000000002',pg_catalog.gen_random_uuid(),pg_catalog.decode(pg_catalog.repeat('00',32),'hex'),current_date,'event1000成功履歴の架空日記','v1'),
  ('fd200000-0000-4000-8000-000000000004','fd100000-0000-4000-8000-000000000002',pg_catalog.gen_random_uuid(),pg_catalog.decode(pg_catalog.repeat('11',32),'hex'),current_date,'event1000不確定履歴の架空日記','v1');
INSERT INTO public.generations(id,entry_id,owner_id,entry_revision,idempotency_key,request_hash,input_snapshot,model_profile_snapshot,is_mock,status,claim_token,deadline_at)
SELECT 'fd300000-0000-4000-8000-000000000003','fd200000-0000-4000-8000-000000000003','fd100000-0000-4000-8000-000000000002',1,pg_catalog.gen_random_uuid(),'event1000-success','event1000成功履歴の架空日記',model_profile_json,false,'succeeded',pg_catalog.gen_random_uuid(),pg_catalog.now()+interval '1 hour' FROM private.generation_policy WHERE id=1;
INSERT INTO public.generations(id,entry_id,owner_id,entry_revision,idempotency_key,request_hash,input_snapshot,model_profile_snapshot,is_mock,status,claim_token,deadline_at)
SELECT 'fd300000-0000-4000-8000-000000000004','fd200000-0000-4000-8000-000000000004','fd100000-0000-4000-8000-000000000002',1,pg_catalog.gen_random_uuid(),'event1000-unknown','event1000不確定履歴の架空日記',model_profile_json,false,'unknown',pg_catalog.gen_random_uuid(),pg_catalog.now()+interval '1 hour' FROM private.generation_policy WHERE id=1;
INSERT INTO private.reservations(generation_id,owner_id,reserved_day,max_cost_micro_usd,state) VALUES
  ('fd300000-0000-4000-8000-000000000003','fd100000-0000-4000-8000-000000000002',current_date,1000000,'consumed'),
  ('fd300000-0000-4000-8000-000000000004','fd100000-0000-4000-8000-000000000002',current_date,1000000,'held');
INSERT INTO private.provider_attempts(generation_id,owner_id,stage,call_index,is_mock,state,finished_at)
VALUES('fd300000-0000-4000-8000-000000000004','fd100000-0000-4000-8000-000000000002','script',1,false,'unknown',pg_catalog.now());
INSERT INTO private.quota_counters(scope,subject,day_key,count,committed_micro_usd) VALUES
  ('global_total',null,null,2,2000000),
  ('global_day',null,current_date,2,2000000),
  ('user_day','fd100000-0000-4000-8000-000000000002',current_date,2,2000000)
ON CONFLICT (scope,subject,day_key) DO UPDATE
SET count=private.quota_counters.count+EXCLUDED.count,
  committed_micro_usd=private.quota_counters.committed_micro_usd+EXCLUDED.committed_micro_usd;

CREATE TABLE test.event1000_policy_before AS
SELECT enabled,user_daily_limit,global_daily_limit,global_total_limit,budget_micro_usd,
  daily_limit_exempt_owners,model_profile_json FROM private.generation_policy WHERE id=1;
CREATE TABLE test.event1000_generations_before AS SELECT * FROM public.generations;
CREATE TABLE test.event1000_reservations_before AS SELECT * FROM private.reservations;
CREATE TABLE test.event1000_attempts_before AS SELECT * FROM private.provider_attempts;
CREATE TABLE test.event1000_counters_before AS SELECT * FROM private.quota_counters;
-- EVENT1000_ACTIVATION_FUNCTION
-- TRIAL_POLICY_STOP_FUNCTION

SET manga_nikki.trial_policy_operation='activate-event1000';
SET manga_nikki.trial_provider_cost_verified='false';
SELECT test.reject_event1000('費用未検証をSQL境界で拒否','TRIAL_PROVIDER_COST_NOT_VERIFIED');
SET manga_nikki.trial_provider_cost_verified='true';
SET manga_nikki.trial_policy_operation='stop';
SELECT test.reject_event1000('別operation contextを拒否','TRIAL_POLICY_CONTEXT_INVALID');
SET manga_nikki.trial_policy_operation='activate-event1000';
UPDATE private.generation_policy SET enabled=false WHERE id=1;
SELECT test.reject_event1000('停止中event250からの移行を拒否');
UPDATE private.generation_policy SET enabled=true,global_total_limit=NULL WHERE id=1;
SELECT test.reject_event1000('全期間件数上限が未設定のstateを拒否');
UPDATE private.generation_policy SET global_total_limit=249 WHERE id=1;
SELECT test.reject_event1000('event250以外の件数上限を拒否');
UPDATE private.generation_policy SET global_total_limit=250,budget_micro_usd=249000000 WHERE id=1;
SELECT test.reject_event1000('event250以外の予約budgetを拒否');
UPDATE private.generation_policy SET budget_micro_usd=250000000,daily_limit_exempt_owners='{}'::uuid[] WHERE id=1;
SELECT test.reject_event1000('owner日次例外がないstateを拒否');
UPDATE private.generation_policy SET daily_limit_exempt_owners=ARRAY['fd100000-0000-4000-8000-000000000002'::uuid] WHERE id=1;

SELECT pg_temp.activate_event1000();
SELECT test.assert((SELECT p.enabled AND p.user_daily_limit=b.user_daily_limit
  AND p.global_daily_limit IS NOT DISTINCT FROM b.global_daily_limit
  AND p.global_total_limit=1000 AND p.budget_micro_usd=1000000000
  AND p.daily_limit_exempt_owners=b.daily_limit_exempt_owners
  AND p.model_profile_json=b.model_profile_json
  AND p.model_profile_json->>'max_cost_micro_usd'='1000000'
  FROM private.generation_policy p CROSS JOIN test.event1000_policy_before b WHERE p.id=1),
  '全期間1000件・内部予約budgetと日次上限・owner例外/profileの保持');
SELECT test.assert(NOT EXISTS(SELECT * FROM test.event1000_generations_before EXCEPT SELECT * FROM public.generations)
  AND NOT EXISTS(SELECT * FROM public.generations EXCEPT SELECT * FROM test.event1000_generations_before),
  'generation履歴・unknown状態を一切変更しない');
SELECT test.assert(NOT EXISTS(SELECT * FROM test.event1000_reservations_before EXCEPT SELECT * FROM private.reservations)
  AND NOT EXISTS(SELECT * FROM private.reservations EXCEPT SELECT * FROM test.event1000_reservations_before)
  AND EXISTS(SELECT 1 FROM private.reservations WHERE state='held'),
  '全reservationとheld状態を一切変更しない');
SELECT test.assert(NOT EXISTS(SELECT * FROM test.event1000_attempts_before EXCEPT SELECT * FROM private.provider_attempts)
  AND NOT EXISTS(SELECT * FROM private.provider_attempts EXCEPT SELECT * FROM test.event1000_attempts_before)
  AND EXISTS(SELECT 1 FROM private.provider_attempts WHERE state='unknown'),
  'provider attemptとunknown状態を一切変更しない');
SELECT test.assert(NOT EXISTS(SELECT * FROM test.event1000_counters_before EXCEPT SELECT * FROM private.quota_counters)
  AND NOT EXISTS(SELECT * FROM private.quota_counters EXCEPT SELECT * FROM test.event1000_counters_before),
  '全quota counterを一切変更しない');
SELECT test.reject_event1000('event1000有効中の二重適用を拒否');

SET manga_nikki.trial_policy_operation='stop';
SELECT test.apply_event1000_stop();
SELECT test.assert((SELECT NOT enabled AND user_daily_limit=3 AND global_daily_limit IS NULL
  AND global_total_limit=1000 AND budget_micro_usd=1000000000
  FROM private.generation_policy WHERE id=1),'停止後もevent1000制限を保持');
SET manga_nikki.trial_policy_operation='activate-event1000';
SET manga_nikki.trial_provider_cost_verified='true';
SELECT test.reject_event1000('停止後のevent1000再有効化を拒否');
SELECT test.assert(NOT EXISTS(SELECT * FROM test.event1000_generations_before EXCEPT SELECT * FROM public.generations)
  AND NOT EXISTS(SELECT * FROM public.generations EXCEPT SELECT * FROM test.event1000_generations_before)
  AND NOT EXISTS(SELECT * FROM test.event1000_reservations_before EXCEPT SELECT * FROM private.reservations)
  AND NOT EXISTS(SELECT * FROM private.reservations EXCEPT SELECT * FROM test.event1000_reservations_before)
  AND NOT EXISTS(SELECT * FROM test.event1000_attempts_before EXCEPT SELECT * FROM private.provider_attempts)
  AND NOT EXISTS(SELECT * FROM private.provider_attempts EXCEPT SELECT * FROM test.event1000_attempts_before)
  AND NOT EXISTS(SELECT * FROM test.event1000_counters_before EXCEPT SELECT * FROM private.quota_counters)
  AND NOT EXISTS(SELECT * FROM private.quota_counters EXCEPT SELECT * FROM test.event1000_counters_before),
  '停止後も全generation・reservation・attempt・counterを保持');
-- PUBLIC_POLICY_STATUS_CHECK
\echo EVENT1000_POLICY_FIXTURE_PASSED
