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
create function test.expect_error(command text, expected_state text, expected_message text default null)
returns void language plpgsql security invoker as $$
declare actual_state text; actual_message text;
begin
  begin
    execute command;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate, actual_message = message_text;
  end;
  perform test.assert(actual_state = expected_state,
    format('SQLSTATE: expected=%s actual=%s message=%s', expected_state, actual_state, actual_message));
  if expected_message is not null then
    perform test.assert(actual_message = expected_message,
      format('業務エラー: expected=%s actual=%s', expected_message, actual_message));
  end if;
end;
$$;
grant execute on all functions in schema test to anon, authenticated, service_role;

select test.assert((select not enabled and user_daily_limit = 2 and global_daily_limit = 0
  and global_total_limit = 0 and budget_micro_usd = 0 and model_profile_json = '{}'::jsonb
  from private.generation_policy where id = 1), '生成policyは閉じた既定値');
select test.assert(has_table_privilege('service_role', 'private.generation_policy', 'SELECT')
  and not has_table_privilege('service_role', 'private.generation_policy', 'INSERT')
  and not has_table_privilege('service_role', 'private.generation_policy', 'UPDATE')
  and not has_table_privilege('service_role', 'private.generation_policy', 'DELETE'),
  'service_roleはpolicyを参照だけできる');
select test.assert(has_table_privilege('service_role', 'private.quota_counters', 'SELECT')
  and has_table_privilege('service_role', 'private.quota_counters', 'INSERT')
  and has_table_privilege('service_role', 'private.quota_counters', 'UPDATE')
  and not has_table_privilege('service_role', 'private.quota_counters', 'DELETE')
  and has_table_privilege('service_role', 'private.reservations', 'SELECT')
  and has_table_privilege('service_role', 'private.reservations', 'INSERT')
  and has_column_privilege('service_role', 'private.reservations', 'state', 'UPDATE')
  and not has_column_privilege('service_role', 'private.reservations', 'owner_id', 'UPDATE')
  and not has_table_privilege('service_role', 'private.reservations', 'DELETE'),
  'service_roleのledger DMLは精算に必要な範囲だけ');
select test.assert(has_table_privilege('service_role', 'private.provider_attempts', 'SELECT')
  and has_table_privilege('service_role', 'private.provider_attempts', 'INSERT')
  and has_column_privilege('service_role', 'private.provider_attempts', 'state', 'UPDATE')
  and has_column_privilege('service_role', 'private.provider_attempts', 'request_id', 'UPDATE')
  and has_column_privilege('service_role', 'private.provider_attempts', 'finished_at', 'UPDATE')
  and not has_column_privilege('service_role', 'private.provider_attempts', 'is_mock', 'UPDATE')
  and not has_table_privilege('service_role', 'private.provider_attempts', 'DELETE'),
  'provider attemptはservice_roleの必要最小権限');
select test.assert(not has_schema_privilege('anon', 'private', 'USAGE')
  and not has_schema_privilege('authenticated', 'private', 'USAGE'),
  'private schemaは一般ユーザーから非公開');

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');

set local role anon;
select test.expect_error('select * from private.generation_policy', '42501');
select test.expect_error('select * from private.quota_counters', '42501');
select test.expect_error('select * from private.reservations', '42501');
select test.expect_error('select * from private.provider_attempts', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
select test.expect_error('select public.find_generation_receipt(null,null,null,null)', '42501');
select test.expect_error('select public.claim_generation(gen_random_uuid())', '42501');
select test.expect_error('select public.begin_provider_attempt(gen_random_uuid(),gen_random_uuid(),''script'',1,false)', '42501');
select test.expect_error('select public.finish_provider_attempt(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),''failed'')', '42501');
select test.expect_error('select public.fail_or_hold_generation(gen_random_uuid(),null,''failed'')', '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select test.expect_error('select * from private.generation_policy', '42501');
select test.expect_error('select * from private.quota_counters', '42501');
select test.expect_error('select * from private.reservations', '42501');
select test.expect_error('select * from private.provider_attempts', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
select test.expect_error('select public.find_generation_receipt(null,null,null,null)', '42501');
select test.expect_error('select public.claim_generation(gen_random_uuid())', '42501');
select test.expect_error('select public.begin_provider_attempt(gen_random_uuid(),gen_random_uuid(),''script'',1,false)', '42501');
select test.expect_error('select public.finish_provider_attempt(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),''failed'')', '42501');
select test.expect_error('select public.fail_or_hold_generation(gen_random_uuid(),null,''failed'')', '42501');
set local role service_role;
select test.expect_error('update private.generation_policy set enabled = true', '42501');
select test.expect_error('delete from private.quota_counters', '42501');
select test.expect_error('update private.reservations set owner_id = gen_random_uuid()', '42501');
select test.expect_error('update private.provider_attempts set is_mock = false', '42501');
select test.expect_error($cmd$insert into private.reservations (generation_id, owner_id, reserved_day, max_cost_micro_usd)
  values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', current_date, 1)$cmd$, '23503');
reset role;

update private.generation_policy set enabled = true, global_daily_limit = 10,
  global_total_limit = 10, budget_micro_usd = 100,
  model_profile_json = '{"profile_id":"fictional-v1","is_mock":true,"max_cost_micro_usd":7,"script":{"model":"fictional-script"},"image":{"model":"fictional-image"}}'::jsonb
where id = 1;
select test.expect_error($cmd$update private.generation_policy set model_profile_json =
  '{"profile_id":"bad","is_mock":false,"max_cost_micro_usd":0}'::jsonb where id = 1$cmd$, '23514');
select test.expect_error($cmd$update private.generation_policy set model_profile_json =
  '{"profile_id":"bad","is_mock":true,"max_cost_micro_usd":1.5}'::jsonb where id = 1$cmd$, '23514');
select test.expect_error($cmd$update private.generation_policy set model_profile_json =
  '{"profile_id":"bad","is_mock":true,"max_cost_micro_usd":-1}'::jsonb where id = 1$cmd$, '23514');
select test.expect_error($cmd$update private.generation_policy set model_profile_json =
  '{"profile_id":"bad","is_mock":true,"max_cost_micro_usd":9223372036854775808}'::jsonb where id = 1$cmd$, '23514');
select test.expect_error($cmd$update private.generation_policy set model_profile_json =
  '{"profile_id":"bad","max_cost_micro_usd":1}'::jsonb where id = 1$cmd$, '23514');
select test.expect_error($cmd$update private.generation_policy set model_profile_json =
  '{"profile_id":"bad","is_mock":true,"max_cost_micro_usd":1,"max_image_calls":0}'::jsonb where id = 1$cmd$, '23514');
select test.expect_error($cmd$update private.generation_policy set model_profile_json =
  '{"profile_id":"bad","is_mock":true,"max_cost_micro_usd":1,"max_image_calls":5}'::jsonb where id = 1$cmd$, '23514');
select test.expect_error($cmd$update private.generation_policy set model_profile_json =
  '{"profile_id":"bad","is_mock":true,"max_cost_micro_usd":1,"max_image_calls":1.5}'::jsonb where id = 1$cmd$, '23514');

set local role service_role;
select test.expect_error('select public.reserve_generation(null,null,1,null,true)', 'P0001', 'AUTH_REQUIRED');
select test.expect_error('select public.reserve_generation(''11111111-1111-4111-8111-111111111111'',null,0,null,true)',
  'P0001', 'INVALID_INPUT');
select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(), current_date, '架空日記A1', 'v1')).id as entry_a1 \gset
select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(), current_date, '架空日記A2', 'v1')).id as entry_a2 \gset
select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(), current_date, '架空日記A3', 'v1')).id as entry_a3 \gset
select (public.create_entry('22222222-2222-4222-8222-222222222222', gen_random_uuid(), current_date, '架空日記B1', 'v1')).id as entry_b1 \gset
select (public.create_entry('22222222-2222-4222-8222-222222222222', gen_random_uuid(), current_date, '削除用の架空日記', 'v1')).id as entry_b2 \gset
select (public.create_entry('22222222-2222-4222-8222-222222222222', gen_random_uuid(), current_date, '期限用の架空日記', 'v1')).id as entry_b3 \gset
select (public.create_entry('33333333-3333-4333-8333-333333333333', gen_random_uuid(), current_date, 'revision用の架空日記', 'v1')).id as entry_c1 \gset
select (public.create_entry('33333333-3333-4333-8333-333333333333', gen_random_uuid(), current_date, '期限精算用の架空日記', 'v1')).id as entry_c2 \gset
select (public.create_entry('44444444-4444-4444-8444-444444444444', gen_random_uuid(), current_date, '画像上限の架空日記', 'v1')).id as entry_d1 \gset
select (public.create_entry('44444444-4444-4444-8444-444444444444', gen_random_uuid(), current_date, '画像失敗再送確認用の架空日記', 'v1')).id as entry_d2 \gset
select test.assert(public.find_generation_receipt('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
  'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1') is null, '未登録キーの照会はNULLを返す');
select test.assert((select count(*) = 0 from private.quota_counters)
  and (select count(*) = 0 from private.reservations)
  and (select count(*) = 0 from public.generations)
  and (select latest_generation_id is null from public.entries where id = :'entry_a1'::uuid),
  '未登録キーの照会は生成台帳・日記ポインタを変更しない');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,false)',
  '11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'P0001', 'GENERATION_DISABLED');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,false)',
  '11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0000'),
  'P0001', 'GENERATION_DISABLED');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,null)',
  '11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001'), 'P0001', 'GENERATION_DISABLED');
select public.reserve_generation('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true) as receipt_a1 \gset
select (:'receipt_a1'::jsonb ->> 'generation_id') as generation_a1 \gset
select test.assert(:'receipt_a1'::jsonb ->> 'status' = 'queued'
  and :'receipt_a1'::jsonb ->> 'status_url' = '/api/v1/generations/' || :'generation_a1',
  '受付RPCはGenerationReceiptを返す');
select test.assert((select input_snapshot = '架空日記A1' and entry_revision = 1
  and model_profile_snapshot = '{"profile_id":"fictional-v1","is_mock":true,"max_cost_micro_usd":7,"script":{"model":"fictional-script"},"image":{"model":"fictional-image"}}'::jsonb
  and is_mock is true from public.generations where id = :'generation_a1'::uuid),
  '日記revisionとpolicy profileをsnapshotし生成元を固定');
select test.assert((select latest_generation_id = :'generation_a1'::uuid
  from public.entries where id = :'entry_a1'::uuid), '予約と同時に日記ポインタを更新');
select test.assert((public.find_generation_receipt('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ->> 'generation_id') = :'generation_a1'
  and (public.find_generation_receipt('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ->> 'status') = 'queued',
  '既存キーの照会はreceiptを返す');
select test.expect_error(format('select public.find_generation_receipt(%L,%L,1,%L)',
  '11111111-1111-4111-8111-111111111111', :'entry_a2'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'P0001', 'IDEMPOTENCY_CONFLICT');
select test.expect_error(format('select public.find_generation_receipt(%L,%L,1,%L)',
  '22222222-2222-4222-8222-222222222222', :'entry_a1'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'P0001', 'NOT_FOUND');
select test.assert((select owner_id = '11111111-1111-4111-8111-111111111111'
  and reserved_day = (statement_timestamp() at time zone 'Asia/Tokyo')::date
  and max_cost_micro_usd = 7 and state = 'reserved'
  from private.reservations where generation_id = :'generation_a1'::uuid),
  'JST日と最大費用を予約ledgerへ保存');

select public.claim_generation(:'generation_a1'::uuid) as claim_a1 \gset
select (:'claim_a1'::jsonb ->> 'claim_token') as claim_token_a1 \gset
select test.assert(:'claim_a1'::jsonb ->> 'input_snapshot' = '架空日記A1'
  and :'claim_a1'::jsonb ->> 'owner_id' = '11111111-1111-4111-8111-111111111111'
  and :'claim_a1'::jsonb ->> 'deadline_at' is not null,
  'claimは本人entryのsnapshotと15分claimを返す');
select test.assert(public.claim_generation(:'generation_a1'::uuid) is null,
  '重複queue配信はrunning jobを再claimしない');
reset role;
update private.generation_policy set enabled = false where id = 1;
set local role service_role;
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''script'',1,false)',
  :'generation_a1', :'claim_token_a1'), 'P0001', 'GENERATION_DISABLED');
reset role;
update private.generation_policy set enabled = true where id = 1;
set local role service_role;
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''script'',1,false)',
  :'generation_a1', '00000000-0000-4000-8000-000000000001'), 'P0001', 'CLAIM_LOST');
select test.expect_error(format('select public.fail_or_hold_generation(%L,%L,''failed'')',
  :'generation_a1', '00000000-0000-4000-8000-000000000001'), 'P0001', 'CLAIM_LOST');
select public.begin_provider_attempt(:'generation_a1'::uuid, :'claim_token_a1'::uuid,
  'script', 1, false) as mock_attempt_a1 \gset
select (:'mock_attempt_a1'::jsonb ->> 'attempt_id') as attempt_a1 \gset
select test.assert(:'mock_attempt_a1'::jsonb ->> 'mode' = 'mock'
  and (:'mock_attempt_a1'::jsonb ->> 'is_mock')::boolean,
  'GENERATION_ENABLED=falseではmock専用attemptだけを返す');
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''script'',1,false)',
  :'generation_a1', :'claim_token_a1'), 'P0001', 'ATTEMPT_UNRESOLVED');
select test.expect_error(format('select public.finish_provider_attempt(%L,%L,%L,''succeeded'')',
  :'generation_a1', '00000000-0000-4000-8000-000000000001', :'attempt_a1'), 'P0001', 'CLAIM_LOST');
select test.expect_error(format('select public.finish_provider_attempt(%L,%L,%L,''succeeded'',''mock-request'')',
  :'generation_a1', :'claim_token_a1', :'attempt_a1'), 'P0001', 'INVALID_INPUT');
select public.finish_provider_attempt(:'generation_a1'::uuid, :'claim_token_a1'::uuid,
  :'attempt_a1'::uuid, 'succeeded') as finished_mock_a1 \gset
select test.assert(:'finished_mock_a1'::jsonb ->> 'state' = 'succeeded'
  and :'finished_mock_a1'::jsonb ->> 'request_id' is null,
  'mock attemptの結果をrequest idなしで確定');
select test.assert(public.finish_provider_attempt(:'generation_a1'::uuid, :'claim_token_a1'::uuid,
  :'attempt_a1'::uuid, 'succeeded') = :'finished_mock_a1'::jsonb,
  '同一結果のfinish再送は冪等');
select test.expect_error(format('select public.finish_provider_attempt(%L,%L,%L,''failed'')',
  :'generation_a1', :'claim_token_a1', :'attempt_a1'), 'P0001', 'ATTEMPT_ALREADY_FINISHED');
select public.begin_provider_attempt(:'generation_a1'::uuid, :'claim_token_a1'::uuid,
  'images', 1, false) as mock_image_a1 \gset
select (:'mock_image_a1'::jsonb ->> 'attempt_id') as image_attempt_a1 \gset
select test.assert((select stage = 'images' from public.generations where id = :'generation_a1'::uuid),
  '最初のimage attemptと同じtransactionでstageを進める');
select public.finish_provider_attempt(:'generation_a1'::uuid, :'claim_token_a1'::uuid,
  :'image_attempt_a1'::uuid, 'succeeded') as finished_mock_image_a1 \gset
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''script'',1,false)',
  :'generation_a1', :'claim_token_a1'), 'P0001', 'STAGE_MISMATCH');
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''images'',2,false)',
  :'generation_a1', :'claim_token_a1'), 'P0001', 'ATTEMPT_LIMIT_REACHED');
reset role;
update private.generation_policy set model_profile_json =
  '{"profile_id":"fictional-real-attempt-v1","is_mock":false,"max_cost_micro_usd":1}'::jsonb
where id = 1;
set local role service_role;
select public.reserve_generation('22222222-2222-4222-8222-222222222222', :'entry_b2'::uuid, 1,
  '12121212-1212-4121-8121-121212121212', true) as receipt_b2 \gset
select (:'receipt_b2'::jsonb ->> 'generation_id') as generation_b2 \gset
select public.claim_generation(:'generation_b2'::uuid) as claim_b2 \gset
select (:'claim_b2'::jsonb ->> 'claim_token') as claim_token_b2 \gset
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''script'',1,false)',
  :'generation_b2', :'claim_token_b2'), 'P0001', 'GENERATION_DISABLED');
select public.begin_provider_attempt(:'generation_b2'::uuid, :'claim_token_b2'::uuid,
  'script', 1, true) as real_attempt_b2 \gset
select (:'real_attempt_b2'::jsonb ->> 'attempt_id') as attempt_b2 \gset
select test.assert(:'real_attempt_b2'::jsonb ->> 'mode' = 'provider'
  and not (:'real_attempt_b2'::jsonb ->> 'is_mock')::boolean,
  '実AI経路は環境とpolicyの両方が有効な場合にだけ記録');
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''images'',1,true)',
  :'generation_b2', :'claim_token_b2'), 'P0001', 'ATTEMPT_UNRESOLVED');
select public.request_entry_deletion('22222222-2222-4222-8222-222222222222', :'entry_b2'::uuid);
select public.fail_or_hold_generation(:'generation_b2'::uuid, :'claim_token_b2'::uuid, 'cancelled') as held_b2 \gset
select test.assert(:'held_b2'::jsonb ->> 'status' = 'unknown'
  and :'held_b2'::jsonb ->> 'reservation_state' = 'held'
  and not (:'held_b2'::jsonb ->> 'released')::boolean,
  '削除とdispatchの後に結果不明ならjobと予算を保持');
select test.assert((select state = 'dispatched' and not is_mock and request_id is null
  from private.provider_attempts where id = :'attempt_b2'::uuid),
  '実送信前attemptはrequest idなしで外部dispatch済みとして記録');
  select test.assert((select count = 2 and committed_micro_usd = 8
  from private.quota_counters where scope = 'global_total'),
  'unknownの予約額を返さない');

reset role;
update private.generation_policy set model_profile_json =
  '{"profile_id":"fictional-four-images-v1","is_mock":false,"max_cost_micro_usd":10,"max_image_calls":4}'::jsonb
where id = 1;
set local role service_role;
select public.reserve_generation('44444444-4444-4444-8444-444444444444', :'entry_d1'::uuid, 1,
  '15151515-1515-4151-8151-151515151515', true) as receipt_b1 \gset
select (:'receipt_b1'::jsonb ->> 'generation_id') as generation_b1 \gset
select test.assert((select model_profile_snapshot ->> 'max_image_calls' = '4'
  from public.generations where id = :'generation_b1'::uuid),
  'max_image_callsをjob snapshotへ固定');
select public.claim_generation(:'generation_b1'::uuid) as claim_b1 \gset
select (:'claim_b1'::jsonb ->> 'claim_token') as claim_token_b1 \gset
select public.begin_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  'script', 1, true) as script_attempt_b1 \gset
select (:'script_attempt_b1'::jsonb ->> 'attempt_id') as script_attempt_id_b1 \gset
select public.finish_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  :'script_attempt_id_b1'::uuid, 'succeeded', 'fictional-script-request')
  as finished_script_b1 \gset
select public.begin_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  'images', 1, true) as image_attempt_b1_1 \gset
select (:'image_attempt_b1_1'::jsonb ->> 'attempt_id') as image_attempt_id_b1_1 \gset
select public.finish_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  :'image_attempt_id_b1_1'::uuid, 'succeeded', 'fictional-image-request-1');
select public.begin_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  'images', 2, true) as image_attempt_b1_2 \gset
select (:'image_attempt_b1_2'::jsonb ->> 'attempt_id') as image_attempt_id_b1_2 \gset
select public.finish_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  :'image_attempt_id_b1_2'::uuid, 'succeeded', 'fictional-image-request-2');
select public.begin_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  'images', 3, true) as image_attempt_b1_3 \gset
select (:'image_attempt_b1_3'::jsonb ->> 'attempt_id') as image_attempt_id_b1_3 \gset
select public.finish_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  :'image_attempt_id_b1_3'::uuid, 'succeeded', 'fictional-image-request-3');
select public.begin_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  'images', 4, true) as image_attempt_b1_4 \gset
select (:'image_attempt_b1_4'::jsonb ->> 'attempt_id') as image_attempt_id_b1_4 \gset
select public.finish_provider_attempt(:'generation_b1'::uuid, :'claim_token_b1'::uuid,
  :'image_attempt_id_b1_4'::uuid, 'failed', 'fictional-image-request-4');
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''images'',5,true)',
  :'generation_b1', :'claim_token_b1'), 'P0001', 'ATTEMPT_LIMIT_REACHED');
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''images'',4,true)',
  :'generation_b1', :'claim_token_b1'), 'P0001', 'ATTEMPT_ALREADY_BEGUN');
select public.fail_or_hold_generation(:'generation_b1'::uuid, :'claim_token_b1'::uuid, 'failed') as failed_b1 \gset
select test.assert(:'failed_b1'::jsonb ->> 'status' = 'failed'
  and :'failed_b1'::jsonb ->> 'reservation_state' = 'consumed'
  and (select count(*) = 5 from private.provider_attempts where generation_id = :'generation_b1'::uuid),
  'profile上限4までの画像attemptと既知failureを精算');

select public.reserve_generation('44444444-4444-4444-8444-444444444444', :'entry_d2'::uuid, 1,
  '16161616-1616-4161-8161-161616161616', true) as receipt_d2 \gset
select (:'receipt_d2'::jsonb ->> 'generation_id') as generation_d2 \gset
select public.claim_generation(:'generation_d2'::uuid) as claim_d2 \gset
select (:'claim_d2'::jsonb ->> 'claim_token') as claim_token_d2 \gset
select public.begin_provider_attempt(:'generation_d2'::uuid, :'claim_token_d2'::uuid,
  'script', 1, true) as script_attempt_d2 \gset
select (:'script_attempt_d2'::jsonb ->> 'attempt_id') as script_attempt_id_d2 \gset
select public.finish_provider_attempt(:'generation_d2'::uuid, :'claim_token_d2'::uuid,
  :'script_attempt_id_d2'::uuid, 'succeeded', 'fictional-script-request-d2');
select public.begin_provider_attempt(:'generation_d2'::uuid, :'claim_token_d2'::uuid,
  'images', 1, true) as image_attempt_d2 \gset
select (:'image_attempt_d2'::jsonb ->> 'attempt_id') as image_attempt_id_d2 \gset
select public.finish_provider_attempt(:'generation_d2'::uuid, :'claim_token_d2'::uuid,
  :'image_attempt_id_d2'::uuid, 'failed', 'fictional-image-request-d2');
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''images'',2,true)',
  :'generation_d2', :'claim_token_d2'), 'P0001', 'ATTEMPT_STAGE_INCOMPLETE');
select public.fail_or_hold_generation(:'generation_d2'::uuid, :'claim_token_d2'::uuid, 'failed') as failed_d2 \gset
select test.assert(:'failed_d2'::jsonb ->> 'status' = 'failed'
  and :'failed_d2'::jsonb ->> 'reservation_state' = 'consumed'
  and (select count(*) = 2 from private.provider_attempts where generation_id = :'generation_d2'::uuid),
  '既知のimage failure後はcall_indexを変えた再送も拒否');

reset role;
update private.generation_policy set model_profile_json =
  '{"profile_id":"fictional-v2","is_mock":true,"max_cost_micro_usd":7}'::jsonb
where id = 1;
set local role service_role;
select public.reserve_generation('33333333-3333-4333-8333-333333333333', :'entry_c2'::uuid, 1,
  '13131313-1313-4131-8131-131313131313', true) as receipt_b3 \gset
select (:'receipt_b3'::jsonb ->> 'generation_id') as generation_b3 \gset
select reserved_day as reserved_today from private.reservations
  where generation_id = :'generation_b3'::uuid \gset
reset role;
update private.quota_counters set count = count - 1,
  committed_micro_usd = committed_micro_usd - 7
  where scope = 'global_day' and day_key = :'reserved_today'::date;
update private.quota_counters set count = count - 1,
  committed_micro_usd = committed_micro_usd - 7
  where scope = 'user_day' and subject = '33333333-3333-4333-8333-333333333333'
    and day_key = :'reserved_today'::date;
insert into private.quota_counters (scope, subject, day_key, count, committed_micro_usd)
values ('global_day', null, :'reserved_today'::date - 1, 1, 7),
  ('user_day', '33333333-3333-4333-8333-333333333333', :'reserved_today'::date - 1, 1, 7);
update private.reservations set reserved_day = :'reserved_today'::date - 1
  where generation_id = :'generation_b3'::uuid;
set local role service_role;
update public.entries set expires_at = statement_timestamp() - interval '1 second'
  where id = :'entry_c2'::uuid;
select public.fail_or_hold_generation(:'generation_b3'::uuid, null, 'cancelled') as released_b3 \gset
select test.assert(:'released_b3'::jsonb ->> 'status' = 'cancelled'
  and :'released_b3'::jsonb ->> 'reservation_state' = 'released'
  and (:'released_b3'::jsonb ->> 'released')::boolean,
  '期限切れで外部未送信のqueued jobをcancelしてrelease');
select test.assert((select count = 4 and committed_micro_usd = 28
    from private.quota_counters where scope = 'global_total')
  and (select count = 1 and committed_micro_usd = 1
    from private.quota_counters where scope = 'user_day'
      and subject = '22222222-2222-4222-8222-222222222222')
  and (select count = 0 and committed_micro_usd = 0
    from private.quota_counters where scope = 'global_day'
      and day_key = :'reserved_today'::date - 1)
  and (select count = 0 and committed_micro_usd = 0
    from private.quota_counters where scope = 'user_day'
      and subject = '33333333-3333-4333-8333-333333333333'
      and day_key = :'reserved_today'::date - 1),
  'releaseは予約時のreserved_dayの全体・ユーザー日別カウンターへ1回だけ戻す');
select test.assert(not (public.fail_or_hold_generation(:'generation_b3'::uuid, null, 'failed')
  ->> 'released')::boolean
  and (select count = 4 and committed_micro_usd = 28
    from private.quota_counters where scope = 'global_total'),
  '精算再送は予約枠を二度返さない');

select public.reserve_generation('33333333-3333-4333-8333-333333333333', :'entry_c1'::uuid, 1,
  '14141414-1414-4141-8141-141414141414', true) as receipt_c1 \gset
select (:'receipt_c1'::jsonb ->> 'generation_id') as generation_c1 \gset
select public.claim_generation(:'generation_c1'::uuid) as claim_c1 \gset
select (:'claim_c1'::jsonb ->> 'claim_token') as claim_token_c1 \gset
update public.generations set deadline_at = statement_timestamp() - interval '1 second'
  where id = :'generation_c1'::uuid;
select test.assert(public.claim_generation(:'generation_c1'::uuid) is null,
  '期限切れrunning jobを再claimしない');
select test.expect_error(format('select public.begin_provider_attempt(%L,%L,''script'',1,false)',
  :'generation_c1', :'claim_token_c1'), 'P0001', 'CLAIM_EXPIRED');
select test.expect_error(format('select public.fail_or_hold_generation(%L,%L,''failed'')',
  :'generation_c1', '00000000-0000-4000-8000-000000000002'), 'P0001', 'CLAIM_LOST');
select public.fail_or_hold_generation(:'generation_c1'::uuid, null, 'failed') as released_c1 \gset
select test.assert(:'released_c1'::jsonb ->> 'status' = 'failed'
  and :'released_c1'::jsonb ->> 'reservation_state' = 'released'
  and (:'released_c1'::jsonb ->> 'released')::boolean,
  '期限切れclaimかつattemptなしなら安全にrelease');

select test.assert((public.reserve_generation('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false) ->> 'generation_id') = :'generation_a1',
  '同一キー再送は停止中も同じreceiptを返す');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,false)',
  '11111111-1111-4111-8111-111111111111', :'entry_a2'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'P0001', 'IDEMPOTENCY_CONFLICT');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '11111111-1111-4111-8111-111111111111', :'entry_b1'::uuid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 'P0001', 'NOT_FOUND');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'), 'P0001', 'ENTRY_BUSY');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '11111111-1111-4111-8111-111111111111', :'entry_a2'::uuid,
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 'P0001', 'TOO_MANY_ACTIVE');
select public.fail_or_hold_generation(:'generation_a1'::uuid, :'claim_token_a1'::uuid, 'failed') as failed_a1 \gset
select test.assert(:'failed_a1'::jsonb ->> 'status' = 'failed'
  and :'failed_a1'::jsonb ->> 'reservation_state' = 'consumed'
  and not (:'failed_a1'::jsonb ->> 'released')::boolean
  and (select state = 'consumed' from private.reservations where generation_id = :'generation_a1'::uuid),
  '確定したmock結果は最大予約額を消費済みにする');
select test.assert((select status = 'failed' and stage is null
  from public.generations where id = :'generation_a1'::uuid),
  'fail処理はactive jobだけをterminalへ遷移');
update public.generations set status = 'failed', completed_at = statement_timestamp()
  where id = :'generation_a1'::uuid;
select public.update_entry('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1, current_date, '改訂後も当初snapshotを維持');
select test.assert((public.find_generation_receipt('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ->> 'generation_id') = :'generation_a1',
  '編集後も元のrevisionによるreceipt照会を維持');
reset role;

update private.generation_policy set enabled = false, global_daily_limit = 0,
  global_total_limit = 0, budget_micro_usd = 0,
  model_profile_json = '{"profile_id":"fictional-v2","is_mock":true,"max_cost_micro_usd":9}'::jsonb
where id = 1;
set local role service_role;
select test.assert((public.find_generation_receipt('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ->> 'generation_id') = :'generation_a1',
  '停止後も有効日記の既存receiptを照会できる');
select public.reserve_generation('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false) as replay_after_stop \gset
select test.assert(:'replay_after_stop'::jsonb ->> 'generation_id' = :'generation_a1',
  '本文編集・policy変更・停止後の同じ要求は既存jobを維持');
select test.assert((select input_snapshot = '架空日記A1'
  and model_profile_snapshot ->> 'profile_id' = 'fictional-v1' and is_mock
  from public.generations where id = :'generation_a1'::uuid), '再送でsnapshotやis_mockを差し替えない');
select test.assert((select count = 4 and committed_micro_usd = 28
  from private.quota_counters where scope = 'global_total'), '冪等再送で予算を二重計上しない');
select test.expect_error(format('select public.reserve_generation(%L,%L,2,%L,false)',
  '11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), 'P0001', 'GENERATION_DISABLED');
reset role;
update private.generation_policy set enabled = true, global_daily_limit = 10,
  global_total_limit = 10, budget_micro_usd = 100,
  model_profile_json = '{"profile_id":"fictional-v2","is_mock":true,"max_cost_micro_usd":7}'::jsonb
where id = 1;
set local role service_role;
select public.reserve_generation('11111111-1111-4111-8111-111111111111', :'entry_a2'::uuid, 1,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', true) as receipt_a2 \gset
select (:'receipt_a2'::jsonb ->> 'generation_id') as generation_a2 \gset
select public.claim_generation(:'generation_a2'::uuid) as claim_a2 \gset
select (:'claim_a2'::jsonb ->> 'claim_token') as claim_token_a2 \gset
select public.begin_provider_attempt(:'generation_a2'::uuid, :'claim_token_a2'::uuid,
  'script', 1, false) as attempt_a2 \gset
select (:'attempt_a2'::jsonb ->> 'attempt_id') as attempt_id_a2 \gset
select public.finish_provider_attempt(:'generation_a2'::uuid, :'claim_token_a2'::uuid,
  :'attempt_id_a2'::uuid, 'failed') as finished_a2 \gset
select public.fail_or_hold_generation(:'generation_a2'::uuid, :'claim_token_a2'::uuid,
  'failed') as failed_a2 \gset
select test.assert(:'failed_a2'::jsonb ->> 'status' = 'failed'
  and :'failed_a2'::jsonb ->> 'reservation_state' = 'consumed'
  and (select state = 'consumed' from private.reservations where generation_id = :'generation_a2'::uuid),
  '確定したmock failureも最大予約額を消費済みにする');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '11111111-1111-4111-8111-111111111111', :'entry_a3'::uuid,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef'), 'P0001', 'USER_LIMIT_REACHED');
select public.update_entry('33333333-3333-4333-8333-333333333333', :'entry_c1'::uuid, 1, current_date, 'revisionを増やす');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '33333333-3333-4333-8333-333333333333', :'entry_c1'::uuid,
  'ffffffff-ffff-4fff-8fff-ffffffffffff'), 'P0001', 'REVISION_CONFLICT');
reset role;
update private.generation_policy set global_total_limit = 2 where id = 1;
set local role service_role;
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '22222222-2222-4222-8222-222222222222', :'entry_b1'::uuid,
  '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001'), 'P0001', 'GLOBAL_LIMIT_REACHED');
update public.entries set deleted_at = statement_timestamp() where id = :'entry_b2'::uuid;
update public.entries set expires_at = statement_timestamp() - interval '1 second' where id = :'entry_b3'::uuid;
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '22222222-2222-4222-8222-222222222222', :'entry_b2'::uuid,
  '11111111-aaaa-4aaa-8aaa-aaaaaaaa0002'), 'P0001', 'NOT_FOUND');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '22222222-2222-4222-8222-222222222222', :'entry_b3'::uuid,
  '11111111-aaaa-4aaa-8aaa-aaaaaaaa0003'), 'P0001', 'NOT_FOUND');
reset role;
update private.generation_policy set model_profile_json = '{}'::jsonb,
  global_total_limit = 10 where id = 1;
set local role service_role;
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,true)',
  '22222222-2222-4222-8222-222222222222', :'entry_b1'::uuid,
  '11111111-aaaa-4aaa-8aaa-aaaaaaaa0004'), 'P0001', 'GENERATION_DISABLED');
reset role;
update private.generation_policy set model_profile_json =
  '{"profile_id":"fictional-real-shaped-v1","is_mock":false,"max_cost_micro_usd":1,"script":{"model":"fictional-script"},"image":{"model":"fictional-image"}}'::jsonb
where id = 1;
set local role service_role;
select public.reserve_generation('22222222-2222-4222-8222-222222222222', :'entry_b1'::uuid, 1,
  '11111111-aaaa-4aaa-8aaa-aaaaaaaa0005', true) as receipt_b1 \gset
select test.assert((select is_mock is false
  and model_profile_snapshot ->> 'profile_id' = 'fictional-real-shaped-v1'
  from public.generations where id = (:'receipt_b1'::jsonb ->> 'generation_id')::uuid),
  '架空profileでもCmax正数を検証しis_mockを固定');

update public.entries set deleted_at = statement_timestamp() where id = :'entry_a1'::uuid;
update public.entries set expires_at = statement_timestamp() - interval '1 second' where id = :'entry_a2'::uuid;
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,false)',
  '11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'P0001', 'NOT_FOUND');
select test.expect_error(format('select public.reserve_generation(%L,%L,1,%L,false)',
  '11111111-1111-4111-8111-111111111111', :'entry_a2'::uuid,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), 'P0001', 'NOT_FOUND');
select test.expect_error(format('select public.find_generation_receipt(%L,%L,1,%L)',
  '11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'P0001', 'NOT_FOUND');
select test.expect_error(format('select public.find_generation_receipt(%L,%L,1,%L)',
  '11111111-1111-4111-8111-111111111111', :'entry_a2'::uuid,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), 'P0001', 'NOT_FOUND');

set local role anon;
select test.expect_error('select id from private.generation_policy', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
select test.expect_error('select public.find_generation_receipt(null,null,null,null)', '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select test.expect_error('select id from private.quota_counters', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
select test.expect_error('select public.find_generation_receipt(null,null,null,null)', '42501');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select test.expect_error('select id from private.generation_policy', '42501');
select test.expect_error('select id from private.reservations', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
select test.expect_error('select public.find_generation_receipt(null,null,null,null)', '42501');
rollback;
