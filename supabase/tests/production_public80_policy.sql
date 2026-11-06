\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE postgres NOLOGIN SUPERUSER;
SET LOCAL ROLE postgres;
CREATE SCHEMA test;
CREATE FUNCTION test.assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '検証失敗: %',label; END IF;
END;
$$;
CREATE FUNCTION test.reject_activation(label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN
    PERFORM pg_temp.activate_public80();
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT IN ('TRIAL_POLICY_STATE_INVALID','TRIAL_PROVIDER_COST_NOT_VERIFIED','TRIAL_POLICY_CONTEXT_INVALID') THEN RAISE; END IF;
    rejected:=true;
  END;
  PERFORM test.assert(rejected,label);
END;
$$;
-- PUBLIC80_ACTIVATION_FUNCTION
SELECT pg_catalog.set_config('manga_nikki.trial_policy_operation','activate-public80',true);
SELECT pg_catalog.set_config('manga_nikki.trial_provider_cost_verified','true',true);
SELECT test.reject_activation('初期policyと空履歴からの有効化を拒否');
INSERT INTO auth.users(id) VALUES ('fc100000-0000-4000-8000-000000000001');
UPDATE private.generation_policy SET enabled=false,user_daily_limit=1,global_daily_limit=1,global_total_limit=1,
  budget_micro_usd=1000000,model_profile_json='{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb;
INSERT INTO public.entries(id,owner_id,create_request_id,create_request_hash,diary_date,body,consent_version)
VALUES('fc200000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000001',pg_catalog.gen_random_uuid(),pg_catalog.decode(pg_catalog.repeat('00',32),'hex'),current_date,'運用試験の架空日記','v1');
INSERT INTO public.generations(id,entry_id,owner_id,entry_revision,idempotency_key,request_hash,input_snapshot,model_profile_snapshot,is_mock,status,claim_token,deadline_at)
SELECT 'fc300000-0000-4000-8000-000000000001','fc200000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000001',1,pg_catalog.gen_random_uuid(),'fixture','運用試験の架空日記',model_profile_json,false,'succeeded',pg_catalog.gen_random_uuid(),pg_catalog.now()+interval '1 hour' FROM private.generation_policy;
INSERT INTO private.reservations(generation_id,owner_id,reserved_day,max_cost_micro_usd,state)
VALUES('fc300000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000001',current_date,1000000,'consumed');
INSERT INTO private.quota_counters(scope,subject,day_key,count,committed_micro_usd)
VALUES('global_total',NULL,NULL,1,1000000),('global_day',NULL,current_date,1,1000000),('user_day','fc100000-0000-4000-8000-000000000001',current_date,1,1000000);
INSERT INTO private.provider_attempts(generation_id,owner_id,stage,call_index,is_mock,state,finished_at)
SELECT 'fc300000-0000-4000-8000-000000000001','fc100000-0000-4000-8000-000000000001',CASE WHEN n=0 THEN 'script' ELSE 'images' END,greatest(n,1),false,'succeeded',pg_catalog.now() FROM pg_catalog.generate_series(0,4) n;
SELECT pg_catalog.set_config('manga_nikki.trial_provider_cost_verified','false',true);
SELECT test.reject_activation('費用確認なしの拒否');
SELECT pg_catalog.set_config('manga_nikki.trial_provider_cost_verified','true',true);
UPDATE private.reservations SET state='held';
SELECT test.reject_activation('不確定予約の拒否');
UPDATE private.reservations SET state='consumed';
UPDATE private.provider_attempts SET state='unknown' WHERE stage='script';
SELECT test.reject_activation('不確定attemptの拒否');
UPDATE private.provider_attempts SET state='succeeded';
UPDATE public.generations SET status='running',stage='saving';
SELECT test.reject_activation('実行中保存の拒否');
UPDATE public.generations SET status='succeeded',stage=NULL;
UPDATE private.quota_counters SET committed_micro_usd=999999 WHERE scope='global_total';
SELECT test.reject_activation('累積台帳不整合の拒否');
UPDATE private.quota_counters SET committed_micro_usd=1000000;
UPDATE private.generation_policy SET enabled=true;
SELECT test.reject_activation('既に有効なpolicyの拒否');
UPDATE private.generation_policy SET enabled=false;
SAVEPOINT active_task;
INSERT INTO private.comic_save_tasks(generation_id,owner_id,entry_revision,diary_date,provider_claim_token,profile_id,script,comic_draft,asset_metadata,save_claim_token,lease_expires_at)
SELECT id,owner_id,1,current_date,claim_token,model_profile_snapshot->>'profile_id','{}'::jsonb,'{}'::jsonb,'[{},{},{},{}]'::jsonb,pg_catalog.gen_random_uuid(),pg_catalog.now()+interval '1 hour' FROM public.generations;
SELECT test.reject_activation('保存task残存の拒否');
ROLLBACK TO active_task;
SAVEPOINT archived_history;
INSERT INTO private.retained_generation_ledger(generation_id,owner_id,generation_status,reservation_present)
VALUES(pg_catalog.gen_random_uuid(),'fc100000-0000-4000-8000-000000000001','failed',false);
SELECT test.reject_activation('退避済み履歴残存の拒否');
ROLLBACK TO archived_history;
SAVEPOINT successful_activation;
SELECT pg_temp.activate_public80();
SELECT test.assert((SELECT enabled AND user_daily_limit=3 AND global_daily_limit IS NULL AND global_total_limit IS NULL AND budget_micro_usd=80000000 AND daily_limit_exempt_owners=ARRAY['fc100000-0000-4000-8000-000000000001'::uuid] FROM private.generation_policy),'成功試験ownerだけを日次例外とした固定policy');
SELECT test.assert((SELECT count(*)=3 AND sum(count)=3 AND sum(committed_micro_usd)=3000000 FROM private.quota_counters),'既存counterの保持');
SELECT test.assert((SELECT count(*)=1 FROM private.reservations WHERE state='consumed' AND max_cost_micro_usd=1000000),'既存予約を再加算しない');
SELECT test.reject_activation('二度目有効化の拒否');
UPDATE private.generation_policy SET enabled=false;
SELECT test.reject_activation('停止後の再有効化も拒否');
ROLLBACK TO successful_activation;
UPDATE private.generation_policy SET model_profile_json=pg_catalog.jsonb_set(model_profile_json,'{max_cost_micro_usd}','999999');
SELECT test.reject_activation('固定profile変更の拒否');
ROLLBACK;
