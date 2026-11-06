\set ON_ERROR_STOP on
begin;
create schema test;
grant usage on schema test to anon, authenticated, service_role;
create function test.assert(ok boolean, label text) returns void
language plpgsql security invoker as $$
begin
  if ok is distinct from true then raise exception '検証失敗: %', label; end if;
end;
$$;
create function test.expect_error(command text, expected_message text) returns void
language plpgsql security invoker as $$
declare actual_message text;
begin
  begin execute command;
  exception when others then get stacked diagnostics actual_message = message_text;
  end;
  perform test.assert(actual_message = expected_message,
    format('業務エラー: expected=%s actual=%s', expected_message, actual_message));
end;
$$;
-- 外部providerに接続せず、架空attemptの既知費用を予約台帳へ確定する。
create function test.consume_mock(actor uuid, entry uuid) returns void
language plpgsql security invoker as $$
declare generation uuid; claim uuid; attempt uuid;
begin
  generation := (public.reserve_mock_generation(actor, entry, 1, gen_random_uuid()) ->> 'generation_id')::uuid;
  claim := (public.claim_generation(generation) ->> 'claim_token')::uuid;
  attempt := (public.begin_provider_attempt(generation, claim, 'script', 1, false) ->> 'attempt_id')::uuid;
  perform public.finish_provider_attempt(generation, claim, attempt, 'succeeded', null);
  perform test.assert(public.fail_or_hold_generation(generation, claim, 'failed') ->> 'reservation_state' = 'consumed',
    '架空attemptの既知費用は返却しない');
end;
$$;
grant execute on all functions in schema test to anon, authenticated, service_role;

select test.assert((select not enabled and global_daily_limit = 0 and global_total_limit = 0
  and budget_micro_usd = 0 and daily_limit_exempt_owners = '{}'::uuid[]
  from private.generation_policy where id = 1), 'migrationは設定を有効化せず例外ownerも登録しない');
set local role anon;
select test.expect_error('select daily_limit_exempt_owners from private.generation_policy', 'permission denied for schema private');
set local role authenticated;
select test.expect_error('select daily_limit_exempt_owners from private.generation_policy', 'permission denied for schema private');
reset role;
select test.assert(not has_column_privilege('service_role', 'private.generation_policy', 'daily_limit_exempt_owners', 'UPDATE'),
  'service_roleから例外ownerを増やせない');

insert into auth.users(id) values
 ('f8000000-0000-4000-8000-000000000001'),
 ('f8000000-0000-4000-8000-000000000002'),
 ('f8000000-0000-4000-8000-000000000003');
update private.generation_policy set enabled = true, user_daily_limit = 3,
 global_daily_limit = null, global_total_limit = null, budget_micro_usd = 80000000,
 daily_limit_exempt_owners = array['f8000000-0000-4000-8000-000000000002']::uuid[],
 model_profile_json = '{"profile_id":"budget-fictional-v1","is_mock":true,"max_cost_micro_usd":1000000}'::jsonb
 where id = 1;
-- 初回trialを含む過去消費はpolicy変更後も累積予算に含める。
insert into private.quota_counters(scope, subject, day_key, count, committed_micro_usd) values
 ('global_total', null, null, 1000, 1000000),
 ('global_day', null, (statement_timestamp() at time zone 'Asia/Tokyo')::date, 1000, 1000000),
 ('user_day', 'f8000000-0000-4000-8000-000000000001',
   (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, 3, 3000000);
set local role service_role;
select (public.create_entry('f8000000-0000-4000-8000-000000000001', gen_random_uuid(), current_date, '通常枠の架空日記', 'v1')).id as normal_entry \gset
select (public.create_entry('f8000000-0000-4000-8000-000000000002', gen_random_uuid(), current_date, 'デバッグ枠の架空日記', 'v1')).id as debug_entry \gset
select (public.create_entry('f8000000-0000-4000-8000-000000000002', gen_random_uuid(), current_date, 'active確認の架空日記', 'v1')).id as debug_entry2 \gset
select (public.create_entry('f8000000-0000-4000-8000-000000000003', gen_random_uuid(), current_date, '他ownerの架空日記', 'v1')).id as other_entry \gset
select test.assert((public.get_generation_quota('f8000000-0000-4000-8000-000000000001') ->> 'remaining_today')::integer = 3,
 'JST前日の3回は今日の枠を減らさない');
select test.consume_mock('f8000000-0000-4000-8000-000000000001', :'normal_entry'::uuid) from generate_series(1, 3);
select test.expect_error(format('select public.reserve_mock_generation(%L,%L,1,gen_random_uuid())',
 'f8000000-0000-4000-8000-000000000001', :'normal_entry'), 'USER_LIMIT_REACHED');
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000001') ->> 'remaining_today' = '0'
 and public.get_generation_quota('f8000000-0000-4000-8000-000000000001') ->> 'generation_available' = 'false',
 '通常ownerの4回目はquota・予約の両方で止まる');
select test.consume_mock('f8000000-0000-4000-8000-000000000002', :'debug_entry'::uuid) from generate_series(1, 4);
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'remaining_today' = '72'
 and public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'generation_available' = 'true',
 '例外ownerは4回目も許可し、初回と通常ownerとデバッグの費用を共通予算から差し引く');
select test.assert((select count(*) = 5 from jsonb_object_keys(public.get_generation_quota('f8000000-0000-4000-8000-000000000002'))),
 'quota v1のfieldを増やさず例外設定を公開しない');
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000003') ->> 'remaining_today' = '3',
 '別ownerは例外を引き継がない');
select gen_random_uuid() as debug_key \gset
select public.reserve_mock_generation('f8000000-0000-4000-8000-000000000002', :'debug_entry'::uuid, 1, :'debug_key') as debug_receipt \gset
select (:'debug_receipt'::jsonb ->> 'generation_id') as debug_generation \gset
select test.expect_error(format('select public.reserve_mock_generation(%L,%L,1,gen_random_uuid())',
 'f8000000-0000-4000-8000-000000000002', :'debug_entry2'), 'TOO_MANY_ACTIVE');
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'generation_available' = 'false',
 '例外ownerもactive job中は新規受付不可');
reset role;
update private.generation_policy set enabled = false where id = 1;
set local role service_role;
select test.assert(public.reserve_mock_generation('f8000000-0000-4000-8000-000000000002', :'debug_entry'::uuid, 1, :'debug_key') = :'debug_receipt'::jsonb,
 '例外ownerも停止後の同一キー再送は元receiptで二重計上しない');
select test.expect_error(format('select public.reserve_mock_generation(%L,%L,1,gen_random_uuid())',
 'f8000000-0000-4000-8000-000000000002', :'debug_entry2'), 'GENERATION_DISABLED');
select public.fail_or_hold_generation(:'debug_generation'::uuid, null, 'failed');
reset role;
update private.generation_policy set enabled = true, global_daily_limit = 1007 where id = 1;
set local role service_role;
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'generation_available' = 'false', '明示した全体日次件数capは例外ownerにも有効');
select test.expect_error(format('select public.reserve_mock_generation(%L,%L,1,gen_random_uuid())',
 'f8000000-0000-4000-8000-000000000002', :'debug_entry'), 'GLOBAL_LIMIT_REACHED');
reset role;
update private.generation_policy set global_daily_limit = null, global_total_limit = 1007 where id = 1;
set local role service_role;
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'generation_available' = 'false', '明示した全期間件数capも有効');
select test.expect_error(format('select public.reserve_mock_generation(%L,%L,1,gen_random_uuid())',
 'f8000000-0000-4000-8000-000000000002', :'debug_entry'), 'GLOBAL_LIMIT_REACHED');
reset role;
update private.generation_policy set global_total_limit = null, budget_micro_usd = 9000000 where id = 1;
set local role service_role;
select test.consume_mock('f8000000-0000-4000-8000-000000000002', :'debug_entry'::uuid);
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'remaining_today' = '0'
 and public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'generation_available' = 'false',
 '例外ownerも予算最終枠で停止する');
select test.expect_error(format('select public.reserve_mock_generation(%L,%L,1,gen_random_uuid())',
 'f8000000-0000-4000-8000-000000000002', :'debug_entry'), 'GLOBAL_LIMIT_REACHED');
select test.assert((select committed_micro_usd = 9000000 and count = 1008 from private.quota_counters where scope = 'global_total'),
 '予算とcountは過去分を維持し新規受付だけ加算する');
reset role;
-- 無料mockも例外ownerへ有限整数のv1 quotaを返す。
update private.generation_policy set model_profile_json = '{"profile_id":"free-fictional-v1","is_mock":true,"max_cost_micro_usd":0}'::jsonb where id = 1;
set local role service_role;
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'remaining_today' = '1'
 and public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'generation_available' = 'true',
 '無料mockはゼロ除算せず1回以上利用可能なことを表す');
reset role;
-- 以下は隔離DB内の台帳操作だけで、provider APIには接続しない。
update private.generation_policy set budget_micro_usd = 80000000,
 model_profile_json = '{"profile_id":"openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1","is_mock":false,"max_cost_micro_usd":1000000,"max_image_calls":4,"provider":"openai","script_model":"gpt-4.1-mini-2025-04-14","image_model":"gpt-image-2.5-flare","color_mode":"monochrome"}'::jsonb
 where id = 1;
set local role service_role;
select gen_random_uuid() as unknown_key \gset
select (public.reserve_openai_generation('f8000000-0000-4000-8000-000000000002', :'debug_entry'::uuid, 1, :'unknown_key', true) ->> 'generation_id') as unknown_generation \gset
select (public.claim_generation(:'unknown_generation'::uuid) ->> 'claim_token') as unknown_claim \gset
select (public.begin_provider_attempt(:'unknown_generation'::uuid, :'unknown_claim'::uuid, 'script', 1, true) ->> 'attempt_id') as unknown_attempt \gset
select public.finish_provider_attempt(:'unknown_generation'::uuid, :'unknown_claim'::uuid, :'unknown_attempt'::uuid, 'unknown', 'fictional-public80-unknown');
select test.assert(public.fail_or_hold_generation(:'unknown_generation'::uuid, :'unknown_claim'::uuid, 'failed') ->> 'reservation_state' = 'held',
 '例外ownerのunknownも予約を保持する');
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'remaining_today' = '70',
 'unknownの保持費用もデバッグ残予算から差し引く');
select test.assert(public.fail_or_hold_generation(:'unknown_generation'::uuid, null, 'failed') ->> 'released' = 'false',
 '例外ownerのunknownを自動解放しない');
select test.assert((public.reserve_openai_generation('f8000000-0000-4000-8000-000000000002', :'debug_entry'::uuid, 1, :'unknown_key', true) ->> 'generation_id') = :'unknown_generation'
 and (select count(*) = 1 from private.provider_attempts where generation_id = :'unknown_generation'::uuid),
 'unknownの同一キー再送は元jobだけ返しattemptを増やさない');
reset role;
update private.generation_policy set budget_micro_usd = 9223372036854775807,
 model_profile_json = '{"profile_id":"safe-integer-fictional-v1","is_mock":true,"max_cost_micro_usd":1}'::jsonb
 where id = 1;
set local role service_role;
select test.assert(public.get_generation_quota('f8000000-0000-4000-8000-000000000002') ->> 'remaining_today' = '9007199254740991',
 '例外ownerの残数もJavaScriptの安全な整数範囲に収める');
rollback;
