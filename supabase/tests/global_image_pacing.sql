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
create function test.openai_profile(p_cost bigint)
returns jsonb language sql immutable security invoker set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'profile_id', 'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
    'is_mock', false,
    'max_cost_micro_usd', p_cost,
    'max_image_calls', 4,
    'provider', 'openai',
    'script_model', 'gpt-4.1-mini-2025-04-14',
    'image_model', 'gpt-image-2.5-flare',
    'color_mode', 'monochrome'
  );
$$;
grant execute on all functions in schema test to anon, authenticated, service_role;

select test.assert(public.global_image_pacing_ready(),
  'global image pacing readiness confirms the singleton and fixed policy');
select test.assert(has_function_privilege('service_role',
  'public.global_image_pacing_ready()', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.begin_paced_image_attempts(uuid,uuid,integer[],boolean)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.global_image_pacing_ready()', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.global_image_pacing_ready()', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.begin_paced_image_attempts(uuid,uuid,integer[],boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.begin_paced_image_attempts(uuid,uuid,integer[],boolean)', 'EXECUTE')
  and not has_table_privilege('anon', 'private.image_provider_pacing', 'SELECT')
  and not has_table_privilege('authenticated', 'private.image_provider_pacing', 'SELECT')
  and not has_table_privilege('service_role', 'private.image_provider_pacing', 'INSERT'),
  'pacing RPCはservice_role専用で、browser roleは状態へ直接アクセスできない');

insert into auth.users(id) values
  ('aaaaaaaa-1111-4111-8111-111111111111'),
  ('bbbbbbbb-2222-4222-8222-222222222222');
update private.generation_policy set enabled = true, user_daily_limit = 20,
  global_daily_limit = 20, global_total_limit = 20, budget_micro_usd = 1000,
  model_profile_json = test.openai_profile(17)
where id = 1;

set local role service_role;
select (public.create_entry('aaaaaaaa-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, 'paced generation one', 'v1')).id
  as paced_entry_one \gset
select (public.create_entry('bbbbbbbb-2222-4222-8222-222222222222', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, 'paced generation two', 'v1')).id
  as paced_entry_two \gset
select (public.reserve_openai_generation('aaaaaaaa-1111-4111-8111-111111111111',
  :'paced_entry_one'::uuid, 1, '11111111-1111-4111-8111-111111111111', true)
  ->> 'generation_id') as paced_generation_one \gset
select (public.reserve_openai_generation('bbbbbbbb-2222-4222-8222-222222222222',
  :'paced_entry_two'::uuid, 1, '22222222-2222-4222-8222-222222222222', true)
  ->> 'generation_id') as paced_generation_two \gset
select (public.claim_generation(:'paced_generation_one'::uuid) ->> 'claim_token')
  as paced_token_one \gset
select (public.claim_generation(:'paced_generation_two'::uuid) ->> 'claim_token')
  as paced_token_two \gset

select (public.begin_provider_attempt(:'paced_generation_one'::uuid, :'paced_token_one'::uuid,
  'script', 1, true) ->> 'attempt_id') as paced_script_one \gset
select public.finish_provider_attempt(:'paced_generation_one'::uuid, :'paced_token_one'::uuid,
  :'paced_script_one'::uuid, 'succeeded', 'fictional-paced-script-one');
select (public.begin_provider_attempt(:'paced_generation_two'::uuid, :'paced_token_two'::uuid,
  'script', 1, true) ->> 'attempt_id') as paced_script_two \gset
select public.finish_provider_attempt(:'paced_generation_two'::uuid, :'paced_token_two'::uuid,
  :'paced_script_two'::uuid, 'succeeded', 'fictional-paced-script-two');

select public.begin_paced_image_attempts(:'paced_generation_one'::uuid,
  :'paced_token_one'::uuid, array[1], true) as paced_first_grant \gset
select test.assert(:'paced_first_grant'::jsonb ->> 'status' = 'ready'
  and pg_catalog.jsonb_array_length(:'paced_first_grant'::jsonb -> 'attempts') = 1
  and (select count(*) = 1 from private.provider_attempts
    where generation_id = :'paced_generation_one'::uuid and stage = 'images' and call_index = 1)
  and (select next_slot_at > pg_catalog.clock_timestamp()
      and next_slot_at <= pg_catalog.clock_timestamp() + interval '2 seconds'
    from private.image_provider_pacing where singleton),
  '単一画像は現在のDB時刻で1枠を取得し、次枠は500ms後へ進む');

select public.begin_paced_image_attempts(:'paced_generation_two'::uuid,
  :'paced_token_two'::uuid, array[1], true) as paced_wait \gset
select test.assert(:'paced_wait'::jsonb ->> 'status' = 'waiting'
  and (:'paced_wait'::jsonb ->> 'wait_ms')::integer between 1 and 1000
  and not exists (select 1 from private.provider_attempts
    where generation_id = :'paced_generation_two'::uuid and stage = 'images'),
  'global枠が空くまでは待機だけを返しattemptを記録しない');

select test.expect_error(format(
  'select public.begin_paced_image_attempts(%L,%L,array[1],false)',
  :'paced_generation_two'::uuid, :'paced_token_two'::uuid), 'P0001', 'GENERATION_DISABLED');
select test.expect_error(format(
  'select public.begin_paced_image_attempts(%L,%L,array[1],true)',
  :'paced_generation_two'::uuid, '33333333-3333-4333-8333-333333333333'),
  'P0001', 'CLAIM_LOST');
reset role;
update public.generations set deadline_at = pg_catalog.clock_timestamp() - interval '1 second'
  where id = :'paced_generation_two'::uuid;
set local role service_role;
select test.expect_error(format(
  'select public.begin_paced_image_attempts(%L,%L,array[1],true)',
  :'paced_generation_two'::uuid, :'paced_token_two'::uuid), 'P0001', 'CLAIM_EXPIRED');
reset role;
update public.generations set deadline_at = pg_catalog.clock_timestamp() + interval '10 minutes',
  cancel_requested = true where id = :'paced_generation_two'::uuid;
set local role service_role;
select test.expect_error(format(
  'select public.begin_paced_image_attempts(%L,%L,array[1],true)',
  :'paced_generation_two'::uuid, :'paced_token_two'::uuid), 'P0001', 'GENERATION_CANCELLED');
reset role;
update public.generations set cancel_requested = false where id = :'paced_generation_two'::uuid;
update private.generation_policy set enabled = false where id = 1;
set local role service_role;
select test.expect_error(format(
  'select public.begin_paced_image_attempts(%L,%L,array[1],true)',
  :'paced_generation_two'::uuid, :'paced_token_two'::uuid), 'P0001', 'GENERATION_DISABLED');
reset role;
update private.generation_policy set enabled = true where id = 1;
update private.image_provider_pacing set next_slot_at = pg_catalog.clock_timestamp() - interval '1 hour'
  where singleton;
set local role service_role;

select public.begin_paced_image_attempts(:'paced_generation_two'::uuid,
  :'paced_token_two'::uuid, array[1], true) as paced_second_grant \gset
select test.assert(:'paced_second_grant'::jsonb ->> 'status' = 'ready'
  and (select next_slot_at > pg_catalog.clock_timestamp()
      and next_slot_at <= pg_catalog.clock_timestamp() + interval '2 seconds'
    from private.image_provider_pacing where singleton),
  '長時間idle後も過去slotのcreditを持ち越さず現在時刻から再開する');
select (:'paced_second_grant'::jsonb -> 'attempts' -> 0 ->> 'attempt_id')
  as paced_image_one_two \gset
select public.finish_provider_attempt(:'paced_generation_two'::uuid, :'paced_token_two'::uuid,
  :'paced_image_one_two'::uuid, 'succeeded', 'fictional-paced-image-one-two');

reset role;
update private.image_provider_pacing set next_slot_at = pg_catalog.clock_timestamp() - interval '1 hour'
  where singleton;
set local role service_role;
select public.begin_paced_image_attempts(:'paced_generation_two'::uuid,
  :'paced_token_two'::uuid, array[2, 3, 4], true) as paced_batch \gset
select test.assert(:'paced_batch'::jsonb ->> 'status' = 'ready'
  and pg_catalog.jsonb_array_length(:'paced_batch'::jsonb -> 'attempts') = 3
  and (select count(*) = 3 and bool_and(state = 'dispatched')
    from private.provider_attempts where generation_id = :'paced_generation_two'::uuid
      and stage = 'images' and call_index between 2 and 4)
  and (select next_slot_at > pg_catalog.clock_timestamp()
      and next_slot_at <= pg_catalog.clock_timestamp() + interval '2 seconds'
    from private.image_provider_pacing where singleton),
  '2〜4コマは既存batch試行の原子的な記録を維持し、3枠分を消費する');
select test.assert(
  (select greatest(
    (60000 / slot_interval_ms) + 1,
    ((60000 / (slot_interval_ms * max_batch_size)) + 1) * max_batch_size
  ) <= 150 from private.image_provider_pacing where singleton),
  '500ms間隔と3枚batchの両端を含む最大枠数も60秒あたり150未満');

reset role;
delete from private.image_provider_pacing where singleton;
set local role service_role;
select test.assert(not public.global_image_pacing_ready(),
  'singleton消失はreadinessで検出する');
select test.expect_error(format(
  'select public.begin_paced_image_attempts(%L,%L,array[1],true)',
  :'paced_generation_one'::uuid, :'paced_token_one'::uuid),
  'P0001', 'IMAGE_PACING_NOT_READY');
reset role;
insert into private.image_provider_pacing (singleton, next_slot_at)
values (true, pg_catalog.clock_timestamp());

reset role;
set local role anon;
select test.expect_error('select public.global_image_pacing_ready()', '42501');
select test.expect_error(
  'select public.begin_paced_image_attempts(gen_random_uuid(),gen_random_uuid(),array[1],true)',
  '42501');
select test.expect_error('select * from private.image_provider_pacing', '42501');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-1111-4111-8111-111111111111', true);
select test.expect_error('select public.global_image_pacing_ready()', '42501');
select test.expect_error(
  'select public.begin_paced_image_attempts(gen_random_uuid(),gen_random_uuid(),array[1],true)',
  '42501');
select test.expect_error('select * from private.image_provider_pacing', '42501');
reset role;
rollback;
