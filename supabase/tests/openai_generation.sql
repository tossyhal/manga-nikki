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

create table test.reconcile_fixture (
  ordinal integer primary key,
  owner_id uuid not null,
  create_request_id uuid not null,
  entry_id uuid,
  generation_id uuid
);
insert into test.reconcile_fixture (ordinal, owner_id, create_request_id)
select ordinal,
  pg_catalog.md5('reconcile-owner-' || ordinal::text)::uuid,
  pg_catalog.md5('reconcile-entry-' || ordinal::text)::uuid
from pg_catalog.generate_series(1, 58) ordinal;
insert into auth.users(id) select owner_id from test.reconcile_fixture;
insert into public.entries (owner_id, create_request_id, create_request_hash,
  diary_date, body, consent_version)
select owner_id, create_request_id, pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex'),
  (pg_catalog.statement_timestamp() at time zone 'Asia/Tokyo')::date - 1,
  '照合候補の架空日記 ' || ordinal::text, 'v1'
from test.reconcile_fixture;
update test.reconcile_fixture fixture set entry_id = entry.id
from public.entries entry
where entry.owner_id = fixture.owner_id and entry.create_request_id = fixture.create_request_id;
update public.entries entry set deleted_at = pg_catalog.statement_timestamp()
from test.reconcile_fixture fixture where fixture.ordinal = 54 and entry.id = fixture.entry_id;
update public.entries entry set expires_at = pg_catalog.statement_timestamp() - interval '1 second'
from test.reconcile_fixture fixture where fixture.ordinal = 55 and entry.id = fixture.entry_id;
insert into public.generations (
  id, entry_id, owner_id, entry_revision, idempotency_key, request_hash,
  input_snapshot, model_profile_snapshot, is_mock, status, stage, claim_token,
  deadline_at, cancel_requested, created_at, updated_at, enqueued_at, started_at
)
select pg_catalog.md5('reconcile-generation-' || fixture.ordinal::text)::uuid,
  fixture.entry_id, fixture.owner_id, 1,
  pg_catalog.md5('reconcile-key-' || fixture.ordinal::text)::uuid,
  'reconcile-request-' || fixture.ordinal::text,
  '照合候補の架空日記 ' || fixture.ordinal::text,
  case
    when fixture.ordinal between 28 and 56 then test.openai_profile(1)
    when fixture.ordinal = 57 then '{"profile_id":"reconcile-mock","is_mock":true,"max_cost_micro_usd":1}'::jsonb
    when fixture.ordinal = 58 then '{"profile_id":"reconcile-unsupported","is_mock":false,"max_cost_micro_usd":1}'::jsonb
    else '{"profile_id":"reconcile-queue","is_mock":true,"max_cost_micro_usd":1}'::jsonb
  end,
  fixture.ordinal <= 27 or fixture.ordinal = 57,
  case when fixture.ordinal <= 27 then 'queued' else 'running' end,
  case when fixture.ordinal <= 27 then null else 'saving' end,
  case when fixture.ordinal <= 27 then null else pg_catalog.gen_random_uuid() end,
  case when fixture.ordinal <= 27 then null
    else pg_catalog.statement_timestamp() - interval '2 minutes' end,
  fixture.ordinal in (27, 56),
  pg_catalog.statement_timestamp(),
  case when fixture.ordinal <= 26
    then pg_catalog.statement_timestamp() - interval '4 hours' - fixture.ordinal * interval '1 second'
    else pg_catalog.statement_timestamp() - interval '3 hours' + fixture.ordinal * interval '1 second'
  end,
  case when fixture.ordinal <= 26
    then pg_catalog.statement_timestamp() - interval '10 minutes' - fixture.ordinal * interval '1 second'
    else pg_catalog.statement_timestamp() end,
  case when fixture.ordinal <= 27 then null else pg_catalog.statement_timestamp() end
from test.reconcile_fixture fixture;
update test.reconcile_fixture fixture set generation_id = generation.id
from public.generations generation
where generation.entry_id = fixture.entry_id;

select public.list_generation_reconcile_candidates(25) as prioritized_candidates \gset
select test.assert(pg_catalog.jsonb_array_length(:'prioritized_candidates'::jsonb) = 25
  and (select count(*) = 1 from pg_catalog.jsonb_array_elements(:'prioritized_candidates'::jsonb) item
    where item ->> 'action' = 'cancel')
  and (select count(*) = 24 from pg_catalog.jsonb_array_elements(:'prioritized_candidates'::jsonb) item
    where item ->> 'action' = 'expire')
  and not exists (
    select 1 from pg_catalog.jsonb_array_elements(:'prioritized_candidates'::jsonb)
      with ordinality item(value, ordinal)
    where item.value ->> 'action' = 'enqueue'
  )
  and (select count(*) = 6
    from pg_catalog.jsonb_array_elements(:'prioritized_candidates'::jsonb)
      with ordinality item(value, ordinal)
    where item.ordinal <= 6 and item.value ->> 'action' in ('cancel', 'expire')
  ), 'cancel/expireと有効saving回復候補は古いenqueue候補より優先してlimit内に入る');
select public.list_generation_reconcile_candidates_v2(50) as recovery_candidates \gset
select test.assert(pg_catalog.jsonb_array_length(:'recovery_candidates'::jsonb) = 50
  and (select count(*) = 1 from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb) item
    where item ->> 'action' = 'cancel')
  and (select count(*) = 5 from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb) item
    where item ->> 'action' = 'expire')
  and (select count(*) = 26 from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb) item
    where item ->> 'action' = 'recover-saving')
  and (select count(*) = 18 from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb) item
    where item ->> 'action' = 'enqueue')
  and not exists (
    select 1 from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb)
      with ordinality item(value, ordinal)
    where item.ordinal <= 6 and item.value ->> 'action' not in ('cancel', 'expire')
  )
  and not exists (
    select 1 from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb)
      with ordinality item(value, ordinal)
    where item.ordinal between 7 and 32 and item.value ->> 'action' <> 'recover-saving'
  )
  and not exists (
    select 1 from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb)
      with ordinality item(value, ordinal)
    where item.ordinal > 32 and item.value ->> 'action' <> 'enqueue'
  ), 'v2は精算・有効OpenAI saving回復・enqueueの順で候補を返す');
select test.assert((select count(*) = 26
    from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb) item
    join test.reconcile_fixture fixture
      on fixture.generation_id = (item ->> 'generation_id')::uuid
    where fixture.ordinal between 28 and 53 and item ->> 'action' = 'recover-saving')
  and (select count(*) = 5
    from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb) item
    join test.reconcile_fixture fixture
      on fixture.generation_id = (item ->> 'generation_id')::uuid
    where fixture.ordinal between 54 and 58 and item ->> 'action' = 'expire')
  and not exists (
    select 1 from pg_catalog.jsonb_array_elements(:'recovery_candidates'::jsonb) item
    where item ->> 'action' = 'recover-saving'
      and not exists (
        select 1 from test.reconcile_fixture fixture
        where fixture.ordinal between 28 and 53
          and fixture.generation_id = (item ->> 'generation_id')::uuid
      )
  ), 'v2は有効なOpenAI savingだけ復旧し、削除/cancel/期限・mock・未対応profileは従来expireを返す');

select test.assert(has_function_privilege('service_role',
  'public.reserve_openai_generation(uuid,uuid,integer,uuid,boolean)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.mark_generation_saving(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.list_generation_reconcile_candidates_v2(integer)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.reserve_openai_generation(uuid,uuid,integer,uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.reserve_openai_generation(uuid,uuid,integer,uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.mark_generation_saving(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.mark_generation_saving(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.list_generation_reconcile_candidates_v2(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.list_generation_reconcile_candidates_v2(integer)', 'EXECUTE'),
  'OpenAI予約とsaving移行RPCはservice_role専用');
select test.assert(not has_function_privilege('anon',
  'private.is_valid_openai_generation_profile(jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'private.is_valid_openai_generation_profile(jsonb)', 'EXECUTE'),
  'profile allowlist helperは一般ユーザーに公開しない');

insert into auth.users(id) values
  ('aaaaaaaa-1111-4111-8111-111111111111'),
  ('bbbbbbbb-2222-4222-8222-222222222222'),
  ('cccccccc-3333-4333-8333-333333333333');

set local role service_role;
select (public.create_entry('aaaaaaaa-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, 'OpenAI環境停止用の架空日記', 'v1')).id as env_entry \gset
select (public.create_entry('aaaaaaaa-1111-4111-8111-111111111111', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, 'OpenAI利用枠用の架空日記', 'v1')).id as quota_entry \gset
select (public.create_entry('bbbbbbbb-2222-4222-8222-222222222222', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, '他owner日記', 'v1')).id as other_entry \gset

reset role;
select test.assert(not (select enabled or user_daily_limit <> 2 or global_daily_limit <> 0
  or global_total_limit <> 0 or budget_micro_usd <> 0 or model_profile_json <> '{}'::jsonb
  from private.generation_policy where id = 1),
  'DB policyと予算・全体枠は既定で停止');
update private.generation_policy set enabled = true, user_daily_limit = 20,
  global_daily_limit = 20, global_total_limit = 20, budget_micro_usd = 1000,
  model_profile_json = test.openai_profile(17)
where id = 1;
select test.assert(private.is_valid_openai_generation_profile(test.openai_profile(17)),
  '固定OpenAI profileと正のDB costを許可');
select test.assert(not private.is_valid_openai_generation_profile(test.openai_profile(0)),
  'OpenAI profileのcostは正整数が必要');
select test.assert(not private.is_valid_openai_generation_profile(
  test.openai_profile(17) || '{"provider":"other"}'::jsonb), 'providerの不一致を拒否');
select test.assert(not private.is_valid_openai_generation_profile(
  test.openai_profile(17) || '{"script_model":"other"}'::jsonb), 'script modelの不一致を拒否');
select test.assert(not private.is_valid_openai_generation_profile(
  test.openai_profile(17) || '{"image_model":"other"}'::jsonb), 'image modelの不一致を拒否');
select test.assert(not private.is_valid_openai_generation_profile(
  test.openai_profile(17) || '{"color_mode":"color"}'::jsonb), '白黒設定の不一致を拒否');
select test.assert(not private.is_valid_openai_generation_profile(
  test.openai_profile(17) || '{"max_image_calls":3}'::jsonb), '画像呼出回数の不一致を拒否');
select test.assert(not private.is_valid_openai_generation_profile(
  test.openai_profile(17) || '{"max_cost_micro_usd":1.5}'::jsonb), 'costの小数を拒否');
select test.assert(not private.is_valid_openai_generation_profile(
  test.openai_profile(17) || '{"unexpected":true}'::jsonb), '余分なprofile keyを拒否');

set local role service_role;
select test.expect_error(format('select public.reserve_openai_generation(%L,%L,1,%L,false)',
  'aaaaaaaa-1111-4111-8111-111111111111', :'env_entry'::uuid,
  '11111111-1111-4111-8111-111111111111'), 'P0001', 'GENERATION_DISABLED');
select test.expect_error(format('select public.reserve_openai_generation(%L,%L,1,%L,null)',
  'aaaaaaaa-1111-4111-8111-111111111111', :'env_entry'::uuid,
  '12111111-1111-4111-8111-111111111111'), 'P0001', 'GENERATION_DISABLED');
select test.assert(not exists (select 1 from public.generations where entry_id = :'env_entry'::uuid)
  and not exists (select 1 from private.reservations),
  '環境停止は生成・予約・費用台帳を変更しない');

reset role;
update private.generation_policy set enabled = false where id = 1;
set local role service_role;
select test.expect_error(format('select public.reserve_openai_generation(%L,%L,1,%L,true)',
  'aaaaaaaa-1111-4111-8111-111111111111', :'env_entry'::uuid,
  '13111111-1111-4111-8111-111111111111'), 'P0001', 'GENERATION_DISABLED');
select test.assert(not exists (select 1 from public.generations where entry_id = :'env_entry'::uuid)
  and not exists (select 1 from private.reservations),
  'DB停止は生成・予約・費用台帳を変更しない');

reset role;
update private.generation_policy set enabled = true,
  model_profile_json = test.openai_profile(17) || '{"provider":"other"}'::jsonb
where id = 1;
set local role service_role;
select public.get_generation_quota('aaaaaaaa-1111-4111-8111-111111111111') as unsupported_quota \gset
select test.assert(not (:'unsupported_quota'::jsonb ->> 'generation_available')::boolean
  and not (:'unsupported_quota'::jsonb ->> 'profile_is_mock')::boolean,
  '未対応real profileはquota契約を維持して利用不可');
select test.expect_error(format('select public.reserve_openai_generation(%L,%L,1,%L,true)',
  'aaaaaaaa-1111-4111-8111-111111111111', :'quota_entry'::uuid,
  '14111111-1111-4111-8111-111111111111'), 'P0001', 'GENERATION_DISABLED');

reset role;
update private.generation_policy set model_profile_json = test.openai_profile(17),
  budget_micro_usd = 16
where id = 1;
set local role service_role;
select public.get_generation_quota('aaaaaaaa-1111-4111-8111-111111111111') as over_budget_quota \gset
select test.assert(not (:'over_budget_quota'::jsonb ->> 'generation_available')::boolean
  and not (:'over_budget_quota'::jsonb ->> 'profile_is_mock')::boolean,
  'valid nonmock quotaは最大費用と予算を評価する');
select test.expect_error(format('select public.reserve_openai_generation(%L,%L,1,%L,true)',
  'aaaaaaaa-1111-4111-8111-111111111111', :'quota_entry'::uuid,
  '15111111-1111-4111-8111-111111111111'), 'P0001', 'GLOBAL_LIMIT_REACHED');
reset role;
update private.generation_policy set budget_micro_usd = 1000, global_total_limit = 0 where id = 1;
set local role service_role;
select public.get_generation_quota('aaaaaaaa-1111-4111-8111-111111111111') as no_slots_quota \gset
select test.assert(not (:'no_slots_quota'::jsonb ->> 'generation_available')::boolean,
  'valid nonmock quotaは全体枠も評価する');
select test.expect_error(format('select public.reserve_openai_generation(%L,%L,1,%L,true)',
  'aaaaaaaa-1111-4111-8111-111111111111', :'quota_entry'::uuid,
  '16111111-1111-4111-8111-111111111111'), 'P0001', 'GLOBAL_LIMIT_REACHED');

reset role;
update private.generation_policy set global_total_limit = 20 where id = 1;
set local role service_role;
select test.expect_error(format('select public.reserve_openai_generation(%L,%L,1,%L,true)',
  'aaaaaaaa-1111-4111-8111-111111111111', :'other_entry'::uuid,
  '17111111-1111-4111-8111-111111111111'), 'P0001', 'NOT_FOUND');
select test.assert(not exists (select 1 from public.generations where entry_id = :'other_entry'::uuid)
  and not exists (select 1 from private.reservations),
  '他ownerの日記と費用枠は変更できない');

select public.get_generation_quota('aaaaaaaa-1111-4111-8111-111111111111') as valid_quota \gset
select test.assert((:'valid_quota'::jsonb ->> 'generation_available')::boolean
  and not (:'valid_quota'::jsonb ->> 'profile_is_mock')::boolean
  and (:'valid_quota'::jsonb ->> 'remaining_today')::bigint = 20
  and (:'valid_quota'::jsonb ->> 'reset_at') is not null,
  '対応profileは既存quota shapeでavailability・JST枠を返す');
select public.reserve_openai_generation('aaaaaaaa-1111-4111-8111-111111111111',
  :'quota_entry'::uuid, 1, '18111111-1111-4111-8111-111111111111', true) as receipt \gset
select (:'receipt'::jsonb ->> 'generation_id') as generation_id \gset
select test.assert(:'receipt'::jsonb ->> 'status' = 'queued'
  and :'receipt'::jsonb ->> 'status_url' = '/api/v1/generations/' || :'generation_id'
  and (select model_profile_snapshot = test.openai_profile(17) and is_mock is false
    from public.generations where id = :'generation_id'::uuid)
  and (select max_cost_micro_usd = 17 and state = 'reserved'
    from private.reservations where generation_id = :'generation_id'::uuid)
  and (select count = 1 and committed_micro_usd = 17
    from private.quota_counters where scope = 'global_total'),
  '対応profileは4画像分の予約額を一度だけsnapshot・台帳化する');
select test.expect_error(format('select public.update_entry(%L,%L,1,%L,%L)',
  'aaaaaaaa-1111-4111-8111-111111111111', :'quota_entry'::uuid,
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 2, '予約中は日付も編集できない'),
  'P0001', 'ENTRY_BUSY');
select test.assert((select diary_date = (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1
  from public.entries where id = :'quota_entry'::uuid),
  '予約中の日付変更は拒否しclaim時の表示日付を保つ');

reset role;
update private.generation_policy set enabled = false, model_profile_json = '{}'::jsonb,
  global_total_limit = 0, global_daily_limit = 0, budget_micro_usd = 0
where id = 1;
set local role service_role;
select test.assert((public.reserve_openai_generation('aaaaaaaa-1111-4111-8111-111111111111',
  :'quota_entry'::uuid, 1, '18111111-1111-4111-8111-111111111111', false) ->> 'generation_id')
    = :'generation_id'
  and (select count = 1 and committed_micro_usd = 17
    from private.quota_counters where scope = 'global_total'),
  '停止後の同一要求は既存receiptを返し予算を二重計上しない');
reset role;
update private.generation_policy set enabled = true, user_daily_limit = 20,
  global_daily_limit = 20, global_total_limit = 20, budget_micro_usd = 1000,
  model_profile_json = test.openai_profile(17)
where id = 1;
set local role service_role;

select public.claim_generation(:'generation_id'::uuid) as claim \gset
select (:'claim'::jsonb ->> 'claim_token') as claim_token \gset
select test.assert(:'claim'::jsonb ->> 'diary_date' = (select diary_date::text
    from public.entries where id = :'quota_entry'::uuid)
  and (:'claim'::jsonb ->> 'owner_id') = 'aaaaaaaa-1111-4111-8111-111111111111'
  and (:'claim'::jsonb ->> 'generation_id') = :'generation_id',
  'claimはロックした日記の日付と所有者を返す');
select (public.begin_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  'script', 1, true) ->> 'attempt_id') as script_attempt \gset
select public.finish_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  :'script_attempt'::uuid, 'succeeded', 'fictional-script-request');
select (public.begin_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  'images', 1, true) ->> 'attempt_id') as image_attempt_1 \gset
select public.finish_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  :'image_attempt_1'::uuid, 'succeeded', 'fictional-image-request-1');
select test.expect_error(format('select public.mark_generation_saving(%L,%L)',
  :'generation_id'::uuid, :'claim_token'::uuid), 'P0001', 'ATTEMPT_STAGE_INCOMPLETE');
select (public.begin_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  'images', 2, true) ->> 'attempt_id') as image_attempt_2 \gset
select public.finish_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  :'image_attempt_2'::uuid, 'succeeded', 'fictional-image-request-2');
select (public.begin_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  'images', 3, true) ->> 'attempt_id') as image_attempt_3 \gset
select public.finish_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  :'image_attempt_3'::uuid, 'succeeded', 'fictional-image-request-3');
select (public.begin_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  'images', 4, true) ->> 'attempt_id') as image_attempt_4 \gset
select public.finish_provider_attempt(:'generation_id'::uuid, :'claim_token'::uuid,
  :'image_attempt_4'::uuid, 'succeeded', 'fictional-image-request-4');
select public.mark_generation_saving(:'generation_id'::uuid, :'claim_token'::uuid) as saving \gset
select test.assert(:'saving'::jsonb ->> 'generation_id' = :'generation_id'
  and :'saving'::jsonb ->> 'status' = 'running'
  and :'saving'::jsonb ->> 'stage' = 'saving'
  and (select status = 'running' and stage = 'saving' and comic_json is null
    and completed_at is null from public.generations where id = :'generation_id'::uuid)
  and (select state = 'reserved' from private.reservations where generation_id = :'generation_id'::uuid)
  and (select count(*) = 5 and bool_and(not is_mock and state = 'succeeded')
    from private.provider_attempts where generation_id = :'generation_id'::uuid),
  '5件の実AI attempt成功後にsavingだけを開始する');
select test.assert(public.mark_generation_saving(:'generation_id'::uuid, :'claim_token'::uuid)
  = :'saving'::jsonb,
  '同じclaim・saving状態への再送は同じ結果で冪等');
select test.expect_error(format('select public.mark_generation_saving(%L,%L)',
  :'generation_id'::uuid, '22222222-2222-4222-8222-222222222222'), 'P0001', 'CLAIM_LOST');
select test.assert((select status = 'running' and stage = 'saving'
  from public.generations where id = :'generation_id'::uuid),
  '別claimからの再送ではsaving状態を変更しない');

reset role;
update private.generation_policy set model_profile_json = test.openai_profile(17) where id = 1;
set local role service_role;
select (public.create_entry('bbbbbbbb-2222-4222-8222-222222222222', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, 'claim期限テスト用の架空日記', 'v1')).id as expired_entry \gset
select (public.reserve_openai_generation('bbbbbbbb-2222-4222-8222-222222222222',
  :'expired_entry'::uuid, 1, '19111111-1111-4111-8111-111111111111', true) ->> 'generation_id') as expired_generation \gset
select (public.claim_generation(:'expired_generation'::uuid) ->> 'claim_token') as expired_token \gset
update public.generations set deadline_at = pg_catalog.clock_timestamp() - interval '1 second'
  where id = :'expired_generation'::uuid;
select test.expect_error(format('select public.mark_generation_saving(%L,%L)',
  :'expired_generation'::uuid, :'expired_token'::uuid), 'P0001', 'CLAIM_EXPIRED');
select test.assert((select status = 'running' and stage = 'script'
  from public.generations where id = :'expired_generation'::uuid)
  and (select state = 'reserved' from private.reservations where generation_id = :'expired_generation'::uuid),
  'claim期限後はsavingへ進まず予約状態も変えない');
select public.fail_or_hold_generation(:'expired_generation'::uuid, null, 'failed');

select (public.create_entry('bbbbbbbb-2222-4222-8222-222222222222', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, '削除前savingテスト用の架空日記', 'v1')).id as deleted_entry \gset
select (public.reserve_openai_generation('bbbbbbbb-2222-4222-8222-222222222222',
  :'deleted_entry'::uuid, 1, '20111111-1111-4111-8111-111111111111', true) ->> 'generation_id') as deleted_generation \gset
select (public.claim_generation(:'deleted_generation'::uuid) ->> 'claim_token') as deleted_token \gset
select public.request_entry_deletion('bbbbbbbb-2222-4222-8222-222222222222', :'deleted_entry'::uuid);
select test.expect_error(format('select public.mark_generation_saving(%L,%L)',
  :'deleted_generation'::uuid, :'deleted_token'::uuid), 'P0001', 'GENERATION_CANCELLED');
select test.assert((select status = 'running' and stage = 'script' and cancel_requested
  from public.generations where id = :'deleted_generation'::uuid)
  and (select deleted_at is not null from public.entries where id = :'deleted_entry'::uuid)
  and (select state = 'reserved' from private.reservations where generation_id = :'deleted_generation'::uuid),
  '保存開始前の削除要求を優先してsavingへ進めない');
select public.fail_or_hold_generation(:'deleted_generation'::uuid, :'deleted_token'::uuid, 'failed');

select (public.create_entry('bbbbbbbb-2222-4222-8222-222222222222', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, 'entry期限テスト用の架空日記', 'v1')).id as entry_expiry_entry \gset
select (public.reserve_openai_generation('bbbbbbbb-2222-4222-8222-222222222222',
  :'entry_expiry_entry'::uuid, 1, '21111111-1111-4111-8111-111111111111', true) ->> 'generation_id') as entry_expiry_generation \gset
select (public.claim_generation(:'entry_expiry_generation'::uuid) ->> 'claim_token') as entry_expiry_token \gset
update public.entries set expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  where id = :'entry_expiry_entry'::uuid;
select test.expect_error(format('select public.mark_generation_saving(%L,%L)',
  :'entry_expiry_generation'::uuid, :'entry_expiry_token'::uuid), 'P0001', 'GENERATION_CANCELLED');
select test.assert((select status = 'running' and stage = 'script'
  from public.generations where id = :'entry_expiry_generation'::uuid),
  '期限切れ日記はsavingへ進めない');

reset role;
update private.generation_policy set model_profile_json =
  '{"profile_id":"unsupported-real-test","is_mock":false,"max_cost_micro_usd":3}'::jsonb
where id = 1;
set local role service_role;
select (public.create_entry('cccccccc-3333-4333-8333-333333333333', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, '未対応profile保存ゲートの架空日記', 'v1')).id as unsupported_entry \gset
select (public.reserve_generation('cccccccc-3333-4333-8333-333333333333',
  :'unsupported_entry'::uuid, 1, '22111111-1111-4111-8111-111111111111', true) ->> 'generation_id') as unsupported_generation \gset
select (public.claim_generation(:'unsupported_generation'::uuid) ->> 'claim_token') as unsupported_token \gset
select test.expect_error(format('select public.mark_generation_saving(%L,%L)',
  :'unsupported_generation'::uuid, :'unsupported_token'::uuid), 'P0001', 'GENERATION_DISABLED');
select test.assert((select status = 'running' and stage = 'script'
  from public.generations where id = :'unsupported_generation'::uuid),
  'saving RPCはsnapshotのunsupported profileを拒否する');
select public.fail_or_hold_generation(:'unsupported_generation'::uuid, :'unsupported_token'::uuid, 'failed');

reset role;
update private.generation_policy set model_profile_json =
  '{"profile_id":"mock-saving-test","is_mock":true,"max_cost_micro_usd":1}'::jsonb
where id = 1;
set local role service_role;
select (public.create_entry('cccccccc-3333-4333-8333-333333333333', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, 'mock saving拒否の架空日記', 'v1')).id as mock_entry \gset
select (public.reserve_mock_generation('cccccccc-3333-4333-8333-333333333333',
  :'mock_entry'::uuid, 1, '23111111-1111-4111-8111-111111111111') ->> 'generation_id') as mock_generation \gset
select (public.claim_generation(:'mock_generation'::uuid) ->> 'claim_token') as mock_token \gset
select test.expect_error(format('select public.mark_generation_saving(%L,%L)',
  :'mock_generation'::uuid, :'mock_token'::uuid), 'P0001', 'GENERATION_DISABLED');
select public.fail_or_hold_generation(:'mock_generation'::uuid, :'mock_token'::uuid, 'failed');

reset role;
update private.generation_policy set model_profile_json = test.openai_profile(17) where id = 1;
set local role service_role;
select (public.create_entry('cccccccc-3333-4333-8333-333333333333', gen_random_uuid(),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, '予約額整合性確認の架空日記', 'v1')).id as amount_entry \gset
select (public.reserve_openai_generation('cccccccc-3333-4333-8333-333333333333',
  :'amount_entry'::uuid, 1, '24111111-1111-4111-8111-111111111111', true) ->> 'generation_id') as amount_generation \gset
select (public.claim_generation(:'amount_generation'::uuid) ->> 'claim_token') as amount_token \gset
reset role;
update private.reservations set max_cost_micro_usd = 18
  where generation_id = :'amount_generation'::uuid;
set local role service_role;
select test.expect_error(format('select public.mark_generation_saving(%L,%L)',
  :'amount_generation'::uuid, :'amount_token'::uuid), 'P0001', 'QUOTA_LEDGER_INCONSISTENT');
reset role;
update private.reservations set max_cost_micro_usd = 17
  where generation_id = :'amount_generation'::uuid;
set local role service_role;
select public.fail_or_hold_generation(:'amount_generation'::uuid, :'amount_token'::uuid, 'failed');

set local role anon;
select test.expect_error('select public.reserve_openai_generation(null,null,null,null,true)', '42501');
select test.expect_error('select public.mark_generation_saving(gen_random_uuid(),gen_random_uuid())', '42501');
select test.expect_error('select public.list_generation_reconcile_candidates_v2(25)', '42501');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-1111-4111-8111-111111111111', true);
select test.expect_error('select public.reserve_openai_generation(null,null,null,null,true)', '42501');
select test.expect_error('select public.mark_generation_saving(gen_random_uuid(),gen_random_uuid())', '42501');
select test.expect_error('select public.list_generation_reconcile_candidates_v2(25)', '42501');
reset role;
rollback;
