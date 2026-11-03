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
  and not has_table_privilege('service_role', 'private.reservations', 'UPDATE')
  and not has_table_privilege('service_role', 'private.reservations', 'DELETE'),
  'service_roleのledger DMLは必要な範囲だけ');
select test.assert(not has_schema_privilege('anon', 'private', 'USAGE')
  and not has_schema_privilege('authenticated', 'private', 'USAGE'),
  'private schemaは一般ユーザーから非公開');

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');

set local role anon;
select test.expect_error('select * from private.generation_policy', '42501');
select test.expect_error('select * from private.quota_counters', '42501');
select test.expect_error('select * from private.reservations', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select test.expect_error('select * from private.generation_policy', '42501');
select test.expect_error('select * from private.quota_counters', '42501');
select test.expect_error('select * from private.reservations', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
set local role service_role;
select test.expect_error('update private.generation_policy set enabled = true', '42501');
select test.expect_error('delete from private.quota_counters', '42501');
select test.expect_error('update private.reservations set state = ''released''', '42501');
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
select test.assert((select owner_id = '11111111-1111-4111-8111-111111111111'
  and reserved_day = (statement_timestamp() at time zone 'Asia/Tokyo')::date
  and max_cost_micro_usd = 7 and state = 'reserved'
  from private.reservations where generation_id = :'generation_a1'::uuid),
  'JST日と最大費用を予約ledgerへ保存');
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
update public.generations set status = 'failed', completed_at = statement_timestamp()
  where id = :'generation_a1'::uuid;
select public.update_entry('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1, current_date, '改訂後も当初snapshotを維持');
reset role;

update private.generation_policy set enabled = false, global_daily_limit = 0,
  global_total_limit = 0, budget_micro_usd = 0,
  model_profile_json = '{"profile_id":"fictional-v2","is_mock":true,"max_cost_micro_usd":9}'::jsonb
where id = 1;
set local role service_role;
select public.reserve_generation('11111111-1111-4111-8111-111111111111', :'entry_a1'::uuid, 1,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false) as replay_after_stop \gset
select test.assert(:'replay_after_stop'::jsonb ->> 'generation_id' = :'generation_a1',
  '本文編集・policy変更・停止後の同じ要求は既存jobを維持');
select test.assert((select input_snapshot = '架空日記A1'
  and model_profile_snapshot ->> 'profile_id' = 'fictional-v1' and is_mock
  from public.generations where id = :'generation_a1'::uuid), '再送でsnapshotやis_mockを差し替えない');
select test.assert((select count = 1 and committed_micro_usd = 7
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
update public.generations set status = 'failed', completed_at = statement_timestamp()
  where id = :'generation_a2'::uuid;
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

set local role anon;
select test.expect_error('select id from private.generation_policy', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select test.expect_error('select id from private.quota_counters', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select test.expect_error('select id from private.generation_policy', '42501');
select test.expect_error('select id from private.reservations', '42501');
select test.expect_error('select public.reserve_generation(null,null,null,null,true)', '42501');
rollback;
