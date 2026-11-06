-- test-db.mjsが固定operation本文を注入する。廃棄する専用PostgreSQLクラスタで実行する。
\set ON_ERROR_STOP on
CREATE ROLE postgres NOLOGIN SUPERUSER;
SET ROLE postgres;
CREATE SCHEMA test;
CREATE FUNCTION test.assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '検証失敗: %',label; END IF;
END;
$$;
CREATE FUNCTION test.reject_event250(label text, expected_error text DEFAULT 'TRIAL_POLICY_STATE_INVALID') RETURNS void LANGUAGE plpgsql AS $$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN
    PERFORM pg_temp.activate_event250();
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> expected_error THEN RAISE; END IF;
    rejected:=true;
  END;
  PERFORM test.assert(rejected,label);
END;
$$;
CREATE FUNCTION test.apply_trial_stop() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.apply_trial_policy_stop();
END;
$$;
CREATE TABLE test.event250_before AS
SELECT
  (SELECT count(*) FROM public.generations) AS generations,
  (SELECT count(*) FROM private.reservations) AS reservations,
  (SELECT count(*) FROM private.reservations WHERE state='held') AS held_reservations,
  (SELECT count(*) FROM private.provider_attempts) AS attempts,
  (SELECT count(*) FROM private.provider_attempts WHERE state='unknown') AS unknown_attempts,
  (SELECT count(*) FROM public.generations WHERE status='unknown') AS unknown_generations,
  COALESCE((SELECT count FROM private.quota_counters WHERE scope='global_total'),0) AS total_count,
  COALESCE((SELECT committed_micro_usd FROM private.quota_counters WHERE scope='global_total'),0) AS total_micro_usd,
  COALESCE((SELECT count FROM private.quota_counters WHERE scope='global_day' AND day_key=current_date),0) AS day_count,
  COALESCE((SELECT committed_micro_usd FROM private.quota_counters WHERE scope='global_day' AND day_key=current_date),0) AS day_micro_usd,
  COALESCE((SELECT count FROM private.quota_counters WHERE scope='user_day' AND subject='fd100000-0000-4000-8000-000000000001'::uuid AND day_key=current_date),0) AS owner_day_count,
  COALESCE((SELECT committed_micro_usd FROM private.quota_counters WHERE scope='user_day' AND subject='fd100000-0000-4000-8000-000000000001'::uuid AND day_key=current_date),0) AS owner_day_micro_usd;
-- EVENT250_ACTIVATION_FUNCTION
-- TRIAL_POLICY_STOP_FUNCTION

INSERT INTO auth.users(id) VALUES ('fd100000-0000-4000-8000-000000000001');
UPDATE private.generation_policy SET model_profile_json='{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb WHERE id=1;
INSERT INTO public.entries(id,owner_id,create_request_id,create_request_hash,diary_date,body,consent_version)
VALUES
  ('fd200000-0000-4000-8000-000000000001','fd100000-0000-4000-8000-000000000001',pg_catalog.gen_random_uuid(),pg_catalog.decode(pg_catalog.repeat('00',32),'hex'),current_date,'event250成功履歴の架空日記','v1'),
  ('fd200000-0000-4000-8000-000000000002','fd100000-0000-4000-8000-000000000001',pg_catalog.gen_random_uuid(),pg_catalog.decode(pg_catalog.repeat('11',32),'hex'),current_date,'event250不確定履歴の架空日記','v1');
INSERT INTO public.generations(id,entry_id,owner_id,entry_revision,idempotency_key,request_hash,input_snapshot,model_profile_snapshot,is_mock,status,claim_token,deadline_at)
SELECT 'fd300000-0000-4000-8000-000000000001','fd200000-0000-4000-8000-000000000001','fd100000-0000-4000-8000-000000000001',1,pg_catalog.gen_random_uuid(),'event250-success','event250成功履歴の架空日記',model_profile_json,false,'succeeded',pg_catalog.gen_random_uuid(),pg_catalog.now()+interval '1 hour' FROM private.generation_policy WHERE id=1;
INSERT INTO public.generations(id,entry_id,owner_id,entry_revision,idempotency_key,request_hash,input_snapshot,model_profile_snapshot,is_mock,status,claim_token,deadline_at)
SELECT 'fd300000-0000-4000-8000-000000000002','fd200000-0000-4000-8000-000000000002','fd100000-0000-4000-8000-000000000001',1,pg_catalog.gen_random_uuid(),'event250-unknown','event250不確定履歴の架空日記',model_profile_json,false,'unknown',pg_catalog.gen_random_uuid(),pg_catalog.now()+interval '1 hour' FROM private.generation_policy WHERE id=1;
INSERT INTO private.reservations(generation_id,owner_id,reserved_day,max_cost_micro_usd,state) VALUES
  ('fd300000-0000-4000-8000-000000000001','fd100000-0000-4000-8000-000000000001',current_date,1000000,'consumed'),
  ('fd300000-0000-4000-8000-000000000002','fd100000-0000-4000-8000-000000000001',current_date,1000000,'held');
INSERT INTO private.provider_attempts(generation_id,owner_id,stage,call_index,is_mock,state,finished_at)
VALUES('fd300000-0000-4000-8000-000000000002','fd100000-0000-4000-8000-000000000001','script',1,false,'unknown',pg_catalog.now());
INSERT INTO private.quota_counters(scope,subject,day_key,count,committed_micro_usd) VALUES
  ('global_total',null,null,2,2000000),
  ('global_day',null,current_date,2,2000000),
  ('user_day','fd100000-0000-4000-8000-000000000001',current_date,2,2000000)
ON CONFLICT (scope,subject,day_key) DO UPDATE
SET count=private.quota_counters.count+EXCLUDED.count,
  committed_micro_usd=private.quota_counters.committed_micro_usd+EXCLUDED.committed_micro_usd;
UPDATE private.generation_policy
SET enabled=true,user_daily_limit=3,global_daily_limit=NULL,global_total_limit=NULL,
  budget_micro_usd=80000000,daily_limit_exempt_owners=ARRAY['fd100000-0000-4000-8000-000000000001'::uuid]
WHERE id=1;
CREATE TABLE test.event250_public80_before AS
SELECT enabled,user_daily_limit,global_daily_limit,global_total_limit,budget_micro_usd,
  daily_limit_exempt_owners,model_profile_json FROM private.generation_policy WHERE id=1;
-- PUBLIC_POLICY_STATUS_CHECK

SET manga_nikki.trial_policy_operation='activate-event250';
SET manga_nikki.trial_provider_cost_verified='false';
SELECT test.reject_event250('費用未検証をSQL境界で拒否','TRIAL_PROVIDER_COST_NOT_VERIFIED');
SET manga_nikki.trial_provider_cost_verified='true';
SET manga_nikki.trial_policy_operation='activate-public80';
SELECT test.reject_event250('別operation contextを拒否','TRIAL_POLICY_CONTEXT_INVALID');
SET manga_nikki.trial_policy_operation='activate-event250';
UPDATE private.generation_policy SET enabled=false WHERE id=1;
SELECT test.reject_event250('停止中public80からの移行を拒否');
UPDATE private.generation_policy SET enabled=true WHERE id=1;
UPDATE private.generation_policy SET budget_micro_usd=79000000 WHERE id=1;
SELECT test.reject_event250('public80以外のbudgetを拒否');
UPDATE private.generation_policy SET budget_micro_usd=80000000,daily_limit_exempt_owners='{}'::uuid[] WHERE id=1;
SELECT test.reject_event250('owner例外がないstateを拒否');
UPDATE private.generation_policy SET daily_limit_exempt_owners=ARRAY['fd100000-0000-4000-8000-000000000001'::uuid] WHERE id=1;

SELECT pg_temp.activate_event250();
SELECT test.assert((SELECT p.enabled AND p.global_total_limit=250 AND p.budget_micro_usd=250000000
  AND p.user_daily_limit=b.user_daily_limit AND p.global_daily_limit IS NOT DISTINCT FROM b.global_daily_limit
  AND p.daily_limit_exempt_owners=b.daily_limit_exempt_owners AND p.model_profile_json=b.model_profile_json
  AND p.model_profile_json->>'max_cost_micro_usd'='1000000' AND p.model_profile_json->>'max_image_calls'='4'
  FROM private.generation_policy p CROSS JOIN test.event250_public80_before b WHERE p.id=1),'全期間250件・内部予約budgetとowner例外/profileの固定値');
SELECT test.assert((SELECT count(*) FROM public.generations)=(SELECT generations+2 FROM test.event250_before),'generation履歴を保持');
SELECT test.assert((SELECT count(*) FROM private.reservations)=(SELECT reservations+2 FROM test.event250_before),'既存reservationと追加fixtureを保持');
SELECT test.assert((SELECT count(*) FROM private.reservations WHERE state='held')=(SELECT held_reservations+1 FROM test.event250_before),'既存held reservationを保持');
SELECT test.assert((SELECT count(*) FROM public.generations WHERE status='unknown')=(SELECT unknown_generations+1 FROM test.event250_before),'既存unknown generationを保持');
SELECT test.assert((SELECT count(*)=2 FROM private.reservations WHERE generation_id IN ('fd300000-0000-4000-8000-000000000001','fd300000-0000-4000-8000-000000000002') AND state IN ('consumed','held')),'consumed/held予約stateを保持');
SELECT test.assert((SELECT count FROM private.quota_counters WHERE scope='global_total')=(SELECT total_count+2 FROM test.event250_before) AND (SELECT committed_micro_usd FROM private.quota_counters WHERE scope='global_total')=(SELECT total_micro_usd+2000000 FROM test.event250_before),'累積counterを保持');
SELECT test.assert((SELECT count FROM private.quota_counters WHERE scope='global_day' AND day_key=current_date)=(SELECT day_count+2 FROM test.event250_before) AND (SELECT committed_micro_usd FROM private.quota_counters WHERE scope='global_day' AND day_key=current_date)=(SELECT day_micro_usd+2000000 FROM test.event250_before),'JST日counterを保持');
SELECT test.assert((SELECT count FROM private.quota_counters WHERE scope='user_day' AND subject='fd100000-0000-4000-8000-000000000001'::uuid AND day_key=current_date)=(SELECT owner_day_count+2 FROM test.event250_before) AND (SELECT committed_micro_usd FROM private.quota_counters WHERE scope='user_day' AND subject='fd100000-0000-4000-8000-000000000001'::uuid AND day_key=current_date)=(SELECT owner_day_micro_usd+2000000 FROM test.event250_before),'owner JST日counterを保持');
SELECT test.assert((SELECT count(*) FROM private.provider_attempts)=(SELECT attempts+1 FROM test.event250_before),'provider attempt履歴を保持');
SELECT test.assert((SELECT state='unknown' FROM private.provider_attempts WHERE generation_id='fd300000-0000-4000-8000-000000000002'),'unknown attemptを保持');
SELECT test.assert((SELECT count(*) FROM private.provider_attempts WHERE state='unknown')=(SELECT unknown_attempts+1 FROM test.event250_before),'既存unknown attemptを保持');
SELECT test.reject_event250('event250有効中の二重適用を拒否');

SET manga_nikki.trial_policy_operation='stop';
SELECT test.apply_trial_stop();
SELECT test.assert((SELECT NOT enabled AND user_daily_limit=3 AND global_daily_limit IS NULL AND global_total_limit=250 AND budget_micro_usd=250000000 FROM private.generation_policy WHERE id=1),'stop後もevent250制限を保持');
SELECT test.assert((SELECT count FROM private.quota_counters WHERE scope='global_total')=(SELECT total_count+2 FROM test.event250_before) AND (SELECT committed_micro_usd FROM private.quota_counters WHERE scope='global_total')=(SELECT total_micro_usd+2000000 FROM test.event250_before),'stop後もcounterを保持');
SELECT test.assert((SELECT count FROM private.quota_counters WHERE scope='user_day' AND subject='fd100000-0000-4000-8000-000000000001'::uuid AND day_key=current_date)=(SELECT owner_day_count+2 FROM test.event250_before),'stop後もowner JST日counterを保持');
SELECT test.assert((SELECT count(*) FROM private.reservations)=(SELECT reservations+2 FROM test.event250_before),'stop後もreservationを保持');
SELECT test.assert((SELECT count(*) FROM private.reservations WHERE state='held')=(SELECT held_reservations+1 FROM test.event250_before),'stop後もheld reservationを保持');
SELECT test.assert((SELECT count(*) FROM public.generations WHERE status='unknown')=(SELECT unknown_generations+1 FROM test.event250_before),'stop後もunknown generationを保持');
SELECT test.assert((SELECT count(*) FROM private.provider_attempts WHERE state='unknown')=(SELECT unknown_attempts+1 FROM test.event250_before),'stop後もunknown attemptを保持');
SELECT test.assert((SELECT count(*)=2 FROM private.reservations WHERE generation_id IN ('fd300000-0000-4000-8000-000000000001','fd300000-0000-4000-8000-000000000002') AND state IN ('consumed','held')),'stop後もheld reservationを保持');
SET manga_nikki.trial_policy_operation='activate-event250';
SET manga_nikki.trial_provider_cost_verified='true';
SELECT test.reject_event250('停止後のevent250再有効化を拒否');
\echo EVENT250_POLICY_FIXTURE_PASSED
