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

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
update private.generation_policy set enabled = true,
  user_daily_limit = 10, global_daily_limit = 20, global_total_limit = 20,
  budget_micro_usd = 100,
  model_profile_json = '{"profile_id":"queue-fixed-test-v1","is_mock":true,"max_cost_micro_usd":7}'::jsonb
where id = 1;

set local role service_role;
select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, 'Queue結合用の架空日記', 'v1')).id as entry_id \gset
select public.get_generation_quota('11111111-1111-4111-8111-111111111111') as initial_quota \gset
select test.assert(:'initial_quota'::jsonb ->> 'remaining_today' = '10'
  and (:'initial_quota'::jsonb ->> 'active_generation_id') is null
  and (:'initial_quota'::jsonb ->> 'reset_at') is not null
  and (:'initial_quota'::jsonb ->> 'generation_available')::boolean
  and (:'initial_quota'::jsonb ->> 'profile_is_mock')::boolean,
  'JST quotaは残数・active・reset・mock availabilityを返す');

select public.reserve_mock_generation('11111111-1111-4111-8111-111111111111', :'entry_id'::uuid,
  1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') as receipt \gset
select (:'receipt'::jsonb ->> 'generation_id') as generation_id \gset
select test.assert((:'receipt'::jsonb ->> 'status') = 'queued'
  and (select count(*) = 1 from private.reservations where generation_id = :'generation_id'::uuid)
  and (select is_mock from public.generations where id = :'generation_id'::uuid),
  '環境AI停止中でもmock専用wrapperは1件だけ予約する');
select public.claim_generation(:'generation_id'::uuid) as claim \gset
select (:'claim'::jsonb ->> 'claim_token') as claim_token \gset
select public.begin_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  'script', 1, false) as script_start \gset
select (:'script_start'::jsonb ->> 'attempt_id') as script_attempt \gset
select test.assert(:'script_start'::jsonb ->> 'mode' = 'mock'
  and (:'script_start'::jsonb ->> 'is_mock')::boolean,
  'mock attemptはenv停止中もmock由来でのみ開始できる');
select public.finish_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  :'script_attempt'::uuid, 'succeeded', null);
select (public.begin_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  'images', 1, false) ->> 'attempt_id') as image_attempt \gset
select public.finish_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  :'image_attempt'::uuid, 'succeeded', null);
select public.complete_mock_generation(:'generation_id'::uuid, :'claim_token'::uuid,
  pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'title', '固定の架空サンプル',
    'panels', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('index', 1, 'scene', '場面1', 'caption', '', 'dialogue', ''),
      pg_catalog.jsonb_build_object('index', 2, 'scene', '場面2', 'caption', '', 'dialogue', ''),
      pg_catalog.jsonb_build_object('index', 3, 'scene', '場面3', 'caption', '', 'dialogue', ''),
      pg_catalog.jsonb_build_object('index', 4, 'scene', '場面4', 'caption', '', 'dialogue', '')
    ),
    'visual', pg_catalog.jsonb_build_object(
      'kind', 'page', 'assetId', :'generation_id', 'textMode', 'external'
    )
  )) as completed \gset
select test.assert(:'completed'::jsonb ->> 'status' = 'succeeded'
  and :'completed'::jsonb ->> 'reservation_state' = 'consumed'
  and (select status = 'succeeded' and stage is null and comic_json -> 'visual' ->> 'assetId' = id::text
    from public.generations where id = :'generation_id'::uuid)
  and (select state = 'consumed' from private.reservations where generation_id = :'generation_id'::uuid)
  and (select count(*) = 2 from private.provider_attempts
    where generation_id = :'generation_id'::uuid and is_mock and state = 'succeeded'),
  'mock完了はfixture comic・attempts・reservationを原子的に確定する');
select public.get_generation_quota('11111111-1111-4111-8111-111111111111') as completed_quota \gset
select test.assert(:'completed_quota'::jsonb ->> 'remaining_today' = '9'
  and (:'completed_quota'::jsonb ->> 'active_generation_id') is null,
  'mock完了後はquota残数を一度だけ減らす');

reset role;
update private.generation_policy set enabled = false, global_daily_limit = 0,
  global_total_limit = 0, budget_micro_usd = 0, model_profile_json = '{}'::jsonb
where id = 1;
set local role service_role;
select test.assert((public.reserve_mock_generation('11111111-1111-4111-8111-111111111111',
  :'entry_id'::uuid, 1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ->> 'generation_id') = :'generation_id',
  '既存mock receiptは停止後・profile変更後も維持する');

reset role;
update private.generation_policy set enabled = true, user_daily_limit = 1, global_daily_limit = 20,
  global_total_limit = 20, budget_micro_usd = 100,
  model_profile_json = '{"profile_id":"queue-fixed-test-v1","is_mock":true,"max_cost_micro_usd":7}'::jsonb
where id = 1;
set local role service_role;
select test.expect_error(format('select public.reserve_mock_generation(%L,%L,1,%L)',
  '11111111-1111-4111-8111-111111111111', :'entry_id'::uuid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 'P0001', 'REVISION_ALREADY_GENERATED');

reset role;
update private.generation_policy set user_daily_limit = 10 where id = 1;
set local role service_role;
select public.update_entry('11111111-1111-4111-8111-111111111111', :'entry_id'::uuid,
  1, (statement_timestamp() at time zone 'Asia/Tokyo')::date, '改訂後の架空日記');
select (public.reserve_mock_generation('11111111-1111-4111-8111-111111111111', :'entry_id'::uuid,
  2, 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1') ->> 'generation_id') as revised_generation \gset
select test.assert((select entry_revision = 2 and status = 'queued'
  from public.generations where id = :'revised_generation'::uuid),
  '成功済みgenerationとは別revisionを予約できる');
select public.fail_or_hold_generation(:'revised_generation'::uuid, null, 'failed') as revised_failed \gset
select test.assert(:'revised_failed'::jsonb ->> 'status' = 'failed'
  and (:'revised_failed'::jsonb ->> 'released')::boolean,
  '新revisionの未送信失敗は予約枠を返す');
select (public.reserve_mock_generation('11111111-1111-4111-8111-111111111111', :'entry_id'::uuid,
  2, 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1') ->> 'generation_id') as retry_after_failure \gset
select test.assert((select status = 'queued' and entry_revision = 2
  from public.generations where id = :'retry_after_failure'::uuid),
  '同revisionの先行jobがfailedなら別keyを受け付ける');
select public.fail_or_hold_generation(:'retry_after_failure'::uuid, null, 'failed') as retry_failed \gset
select test.assert(:'retry_failed'::jsonb ->> 'status' = 'failed'
  and (:'retry_failed'::jsonb ->> 'released')::boolean,
  'failed後の再受付も未送信なら枠を返す');

reset role;
update private.generation_policy set enabled = true, user_daily_limit = 10, global_daily_limit = 20,
  global_total_limit = 20, budget_micro_usd = 100,
  model_profile_json = '{"profile_id":"queue-real-shaped-test-v1","is_mock":false,"max_cost_micro_usd":7}'::jsonb
where id = 1;
set local role service_role;
select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, 'real profile gate用の架空日記', 'v1')).id as real_gate_entry \gset
select test.expect_error(format('select public.reserve_mock_generation(%L,%L,1,%L)',
  '11111111-1111-4111-8111-111111111111', :'real_gate_entry'::uuid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 'P0001', 'GENERATION_DISABLED');
select test.assert(not exists (select 1 from public.generations where entry_id = :'real_gate_entry'::uuid),
  '実profileはmock専用wrapperから予約されない');

reset role;
update private.generation_policy set enabled = true,
  model_profile_json = '{"profile_id":"queue-fixed-test-v2","is_mock":true,"max_cost_micro_usd":7}'::jsonb
where id = 1;
set local role service_role;
select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, '未送信精算用の架空日記', 'v1')).id as unsent_entry \gset
select (public.reserve_mock_generation('11111111-1111-4111-8111-111111111111', :'unsent_entry'::uuid,
  1, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') ->> 'generation_id') as unsent_generation \gset
select (public.fail_or_hold_generation(:'unsent_generation'::uuid, null, 'failed') ->> 'released') as released \gset
select test.assert(:'released'::boolean
  and (select status = 'failed' from public.generations where id = :'unsent_generation'::uuid)
  and (select state = 'released' from private.reservations where generation_id = :'unsent_generation'::uuid),
  '未送信queuedの失敗はreservationを一度だけ返す');

select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, '削除照合用の架空日記', 'v1')).id as cancelled_entry \gset
select (public.reserve_mock_generation('11111111-1111-4111-8111-111111111111', :'cancelled_entry'::uuid,
  1, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') ->> 'generation_id') as cancelled_generation \gset
update public.entries set deleted_at = pg_catalog.statement_timestamp()
  where id = :'cancelled_entry'::uuid;
update public.generations set cancel_requested = true
  where id = :'cancelled_generation'::uuid;
select test.assert(exists (
  select 1 from pg_catalog.jsonb_array_elements(public.list_generation_reconcile_candidates(25)) candidate
  where candidate ->> 'generation_id' = :'cancelled_generation'
    and candidate ->> 'action' = 'cancel'
), '削除済みqueuedは直ちにcancel照合対象になる');
select public.fail_or_hold_generation(:'cancelled_generation'::uuid, null, 'failed');
select test.assert((select status = 'cancelled' from public.generations where id = :'cancelled_generation'::uuid)
  and (select state = 'released' from private.reservations where generation_id = :'cancelled_generation'::uuid),
  '削除済みqueuedを安全にcancelし未送信予約を返す');

select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, '再送照合用の架空日記', 'v1')).id as requeue_entry \gset
select (public.reserve_mock_generation('11111111-1111-4111-8111-111111111111', :'requeue_entry'::uuid,
  1, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') ->> 'generation_id') as requeue_generation \gset
update public.generations set enqueued_at = pg_catalog.statement_timestamp() - interval '2 minutes'
  where id = :'requeue_generation'::uuid;
select test.assert(exists (
  select 1 from pg_catalog.jsonb_array_elements(public.list_generation_reconcile_candidates(25)) candidate
  where candidate ->> 'generation_id' = :'requeue_generation' and candidate ->> 'action' = 'enqueue'
), '未配送queuedをQueueへ再送する候補にする');
select test.assert(public.mark_generation_enqueued(:'requeue_generation'::uuid),
  'Queue送信後にenqueue時刻を記録する');
select test.assert(not exists (
  select 1 from pg_catalog.jsonb_array_elements(public.list_generation_reconcile_candidates(25)) candidate
  where candidate ->> 'generation_id' = :'requeue_generation'
), '再送時刻更新後は重複Cronの即時再送を抑える');
select public.fail_or_hold_generation(:'requeue_generation'::uuid, null, 'failed');

select (public.create_entry('11111111-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, '期限切れmock用の架空日記', 'v1')).id as expired_entry \gset
select (public.reserve_mock_generation('11111111-1111-4111-8111-111111111111', :'expired_entry'::uuid,
  1, 'ffffffff-ffff-4fff-8fff-ffffffffffff') ->> 'generation_id') as expired_generation \gset
select public.claim_generation(:'expired_generation'::uuid) as expired_claim \gset
update public.generations set deadline_at = pg_catalog.statement_timestamp() - interval '1 second'
  where id = :'expired_generation'::uuid;
select test.assert(exists (
  select 1 from pg_catalog.jsonb_array_elements(public.list_generation_reconcile_candidates(25)) candidate
  where candidate ->> 'generation_id' = :'expired_generation' and candidate ->> 'action' = 'expire'
), '期限切れrunningは再送せず期限照合だけを行う');
select public.fail_or_hold_generation(:'expired_generation'::uuid, null, 'failed');
select test.assert((select status = 'failed' from public.generations where id = :'expired_generation'::uuid)
  and (select state = 'released' from private.reservations where generation_id = :'expired_generation'::uuid),
  '外部未送信の期限切れmock jobは失敗確定して枠を返す');

reset role;
update private.generation_policy set model_profile_json =
  '{"profile_id":"queue-real-shaped-test-v2","is_mock":false,"max_cost_micro_usd":7}'::jsonb
where id = 1;
set local role service_role;
select (public.create_entry('22222222-2222-4222-8222-222222222222', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, 'unknown保持用の架空日記', 'v1')).id as unknown_entry \gset
select (public.reserve_generation('22222222-2222-4222-8222-222222222222', :'unknown_entry'::uuid,
  1, 'abababab-abab-4bab-8bab-abababababab', true) ->> 'generation_id') as unknown_generation \gset
select public.claim_generation(:'unknown_generation'::uuid) as unknown_claim \gset
select (:'unknown_claim'::jsonb ->> 'claim_token') as unknown_token \gset
select (public.begin_provider_attempt(:'unknown_generation'::uuid, :'unknown_token'::uuid,
  'script', 1, true) ->> 'attempt_id') as unknown_attempt \gset
select public.finish_provider_attempt(:'unknown_generation'::uuid, :'unknown_token'::uuid,
  :'unknown_attempt'::uuid, 'unknown', 'fictional-request-id');
update public.generations set deadline_at = pg_catalog.statement_timestamp() - interval '1 second'
  where id = :'unknown_generation'::uuid;
select public.fail_or_hold_generation(:'unknown_generation'::uuid, null, 'failed');
select test.assert((select status = 'unknown' from public.generations where id = :'unknown_generation'::uuid)
  and (select state = 'held' from private.reservations where generation_id = :'unknown_generation'::uuid)
  and not exists (
    select 1 from pg_catalog.jsonb_array_elements(public.list_generation_reconcile_candidates(25)) candidate
    where candidate ->> 'generation_id' = :'unknown_generation'
  ), '送信結果不明のjobはheldのまま再配送候補に戻さない');

set local role anon;
select test.expect_error('select public.get_generation_quota(null)', '42501');
select test.expect_error('select public.list_generation_reconcile_candidates(25)', '42501');
select test.expect_error('select public.reserve_mock_generation(null,null,null,null)', '42501');
reset role;
rollback;
