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
    perform test.assert(actual_message = expected_message, '期待した業務エラーで拒否');
  end if;
end;
$$;
grant execute on all functions in schema test to anon, authenticated, service_role;

insert into auth.users(id) values
  ('10101010-1010-4010-8010-101010101010'),
  ('20202020-2020-4020-8020-202020202020'),
  ('30303030-3030-4030-8030-303030303030'),
  ('40404040-4040-4040-8040-404040404040'),
  ('50505050-5050-4050-8050-505050505050');
update public.entries set deleted_at = null, expires_at = statement_timestamp() + interval '30 days'
where owner_id not in (
  '10101010-1010-4010-8010-101010101010', '20202020-2020-4020-8020-202020202020',
  '30303030-3030-4030-8030-303030303030', '40404040-4040-4040-8040-404040404040',
  '50505050-5050-4050-8050-505050505050'
);

set local role service_role;
select test.assert(has_table_privilege('service_role', 'public.assets', 'SELECT')
  and has_table_privilege('service_role', 'public.assets', 'INSERT')
  and not has_table_privilege('service_role', 'public.assets', 'UPDATE')
  and not has_table_privilege('service_role', 'public.assets', 'DELETE')
  and not has_table_privilege('service_role', 'public.entries', 'DELETE')
  and not has_table_privilege('service_role', 'public.generations', 'DELETE')
  and not has_table_privilege('service_role', 'private.reservations', 'DELETE')
  and not has_table_privilege('service_role', 'private.provider_attempts', 'DELETE')
  and not has_table_privilege('service_role', 'private.retained_generation_ledger', 'SELECT')
  and has_function_privilege('service_role', 'public.claim_retention_cleanup(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.claim_retention_cleanup(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_retention_cleanup(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.finalize_retention_cleanup(uuid,uuid,boolean)', 'EXECUTE'),
  'service_roleのcleanup権限はRPCとasset登録に限定');
select test.expect_error('delete from public.assets where false', '42501');

select (public.create_entry('10101010-1010-4010-8010-101010101010',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', current_date, '監査fixtureの架空日記', 'v1')).id
  as archived_entry_id \gset
select (public.create_entry('20202020-2020-4020-8020-202020202020',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', current_date, 'queued fixtureの架空日記', 'v1')).id
  as queued_entry_id \gset
select (public.create_entry('30303030-3030-4030-8030-303030303030',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', current_date, 'running fixtureの架空日記', 'v1')).id
  as running_entry_id \gset
select (public.create_entry('40404040-4040-4040-8040-404040404040',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', current_date, '本人閲覧fixtureの架空日記', 'v1')).id
  as own_entry_id \gset
select (public.create_entry('50505050-5050-4050-8050-505050505050',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', current_date, '他人閲覧fixtureの架空日記', 'v1')).id
  as other_entry_id \gset

select (statement_timestamp() at time zone 'Asia/Tokyo')::date as today \gset
insert into public.generations (
  id, entry_id, owner_id, entry_revision, idempotency_key, request_hash,
  input_snapshot, model_profile_snapshot, is_mock, status, stage, error_code, completed_at
) values
  ('11111111-aaaa-4aaa-8aaa-aaaaaaaa0001', :'archived_entry_id',
   '10101010-1010-4010-8010-101010101010', 1, '11111111-bbbb-4bbb-8bbb-111111111111',
   'fictional-hash-a', '架空fixtureのみ', '{}'::jsonb, false, 'unknown', null, 'RESULT_UNKNOWN', statement_timestamp()),
  ('22222222-aaaa-4aaa-8aaa-aaaaaaaa0002', :'queued_entry_id',
   '20202020-2020-4020-8020-202020202020', 1, '22222222-bbbb-4bbb-8bbb-222222222222',
   'fictional-hash-b', '架空fixtureのみ', '{}'::jsonb, true, 'queued', null, null, null),
  ('33333333-aaaa-4aaa-8aaa-aaaaaaaa0003', :'running_entry_id',
   '30303030-3030-4030-8030-303030303030', 1, '33333333-bbbb-4bbb-8bbb-333333333333',
   'fictional-hash-c', '架空fixtureのみ', '{}'::jsonb, true, 'running', 'script', null, null),
  ('44444444-aaaa-4aaa-8aaa-aaaaaaaa0004', :'own_entry_id',
   '40404040-4040-4040-8040-404040404040', 1, '44444444-bbbb-4bbb-8bbb-444444444444',
   'fictional-hash-d', '架空fixtureのみ', '{}'::jsonb, true, 'succeeded', null, null, statement_timestamp()),
  ('55555555-aaaa-4aaa-8aaa-aaaaaaaa0005', :'other_entry_id',
   '50505050-5050-4050-8050-505050505050', 1, '55555555-bbbb-4bbb-8bbb-555555555555',
   'fictional-hash-e', '架空fixtureのみ', '{}'::jsonb, true, 'succeeded', null, null, statement_timestamp());
update public.entries set latest_generation_id = '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001'
  where id = :'archived_entry_id';
update public.entries set latest_generation_id = '22222222-aaaa-4aaa-8aaa-aaaaaaaa0002'
  where id = :'queued_entry_id';
update public.entries set latest_generation_id = '33333333-aaaa-4aaa-8aaa-aaaaaaaa0003'
  where id = :'running_entry_id';
update public.entries set latest_generation_id = '44444444-aaaa-4aaa-8aaa-aaaaaaaa0004'
  where id = :'own_entry_id';
update public.entries set latest_generation_id = '55555555-aaaa-4aaa-8aaa-aaaaaaaa0005'
  where id = :'other_entry_id';

insert into private.reservations (
  generation_id, owner_id, reserved_day, max_cost_micro_usd, state
) values
  ('11111111-aaaa-4aaa-8aaa-aaaaaaaa0001', '10101010-1010-4010-8010-101010101010',
   :'today'::date - 1, 17, 'held'),
  ('22222222-aaaa-4aaa-8aaa-aaaaaaaa0002', '20202020-2020-4020-8020-202020202020',
   :'today'::date, 5, 'reserved'),
  ('33333333-aaaa-4aaa-8aaa-aaaaaaaa0003', '30303030-3030-4030-8030-303030303030',
   :'today'::date, 7, 'reserved');
insert into private.provider_attempts (
  id, generation_id, owner_id, stage, call_index, is_mock, state, request_id, started_at, finished_at
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
  '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001',
  '10101010-1010-4010-8010-101010101010', 'script', 1, false, 'unknown',
  'fictional-provider-request', statement_timestamp() - interval '1 minute', statement_timestamp()
);

insert into private.quota_counters (scope, subject, day_key, count, committed_micro_usd)
values ('global_total', null, null, 1, 5)
on conflict (scope, subject, day_key) do update set
  count = private.quota_counters.count + excluded.count,
  committed_micro_usd = private.quota_counters.committed_micro_usd + excluded.committed_micro_usd;
insert into private.quota_counters (scope, subject, day_key, count, committed_micro_usd)
values ('global_day', null, :'today'::date, 1, 5)
on conflict (scope, subject, day_key) do update set
  count = private.quota_counters.count + excluded.count,
  committed_micro_usd = private.quota_counters.committed_micro_usd + excluded.committed_micro_usd;
insert into private.quota_counters (scope, subject, day_key, count, committed_micro_usd)
values ('user_day', '20202020-2020-4020-8020-202020202020', :'today'::date, 1, 5)
on conflict (scope, subject, day_key) do update set
  count = private.quota_counters.count + excluded.count,
  committed_micro_usd = private.quota_counters.committed_micro_usd + excluded.committed_micro_usd;
insert into private.quota_counters (scope, subject, day_key, count, committed_micro_usd)
values ('global_total', null, null, 1, 7)
on conflict (scope, subject, day_key) do update set
  count = private.quota_counters.count + excluded.count,
  committed_micro_usd = private.quota_counters.committed_micro_usd + excluded.committed_micro_usd;
insert into private.quota_counters (scope, subject, day_key, count, committed_micro_usd)
values ('global_day', null, :'today'::date, 1, 7)
on conflict (scope, subject, day_key) do update set
  count = private.quota_counters.count + excluded.count,
  committed_micro_usd = private.quota_counters.committed_micro_usd + excluded.committed_micro_usd;
insert into private.quota_counters (scope, subject, day_key, count, committed_micro_usd)
values ('user_day', '30303030-3030-4030-8030-303030303030', :'today'::date, 1, 7)
on conflict (scope, subject, day_key) do update set
  count = private.quota_counters.count + excluded.count,
  committed_micro_usd = private.quota_counters.committed_micro_usd + excluded.committed_micro_usd;

insert into public.assets (id, generation_id, owner_id, object_path, media_type, byte_size, width, height)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001', '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001',
   '10101010-1010-4010-8010-101010101010',
   '10101010-1010-4010-8010-101010101010/11111111-aaaa-4aaa-8aaa-aaaaaaaa0001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001.png',
   'image/png', 1024, 64, 64),
  ('44444444-aaaa-4aaa-8aaa-444444440001', '44444444-aaaa-4aaa-8aaa-aaaaaaaa0004',
   '40404040-4040-4040-8040-404040404040',
   '40404040-4040-4040-8040-404040404040/44444444-aaaa-4aaa-8aaa-aaaaaaaa0004/44444444-aaaa-4aaa-8aaa-444444440001.png',
   'image/png', 1024, 64, 64),
  ('55555555-aaaa-4aaa-8aaa-555555550001', '55555555-aaaa-4aaa-8aaa-aaaaaaaa0005',
   '50505050-5050-4050-8050-505050505050',
   '50505050-5050-4050-8050-505050505050/55555555-aaaa-4aaa-8aaa-aaaaaaaa0005/55555555-aaaa-4aaa-8aaa-555555550001.png',
   'image/png', 1024, 64, 64);
select test.expect_error(format(
  'insert into public.assets (id,generation_id,owner_id,object_path,media_type,byte_size,width,height) values (%L,%L,%L,%L,%L,1,1,1)',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002', '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001',
  '10101010-1010-4010-8010-101010101010',
  '50505050-5050-4050-8050-505050505050/11111111-aaaa-4aaa-8aaa-aaaaaaaa0001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002.png',
  'image/png'), '23514');

update public.entries set expires_at = statement_timestamp() - interval '1 second'
where id = :'archived_entry_id';
select public.request_entry_deletion('20202020-2020-4020-8020-202020202020', :'queued_entry_id');
select public.request_entry_deletion('30303030-3030-4030-8030-303030303030', :'running_entry_id');
update public.generations set claim_token = 'cccccccc-dddd-4ddd-8ddd-cccccccccccc',
  deadline_at = statement_timestamp() + interval '15 minutes', started_at = statement_timestamp()
where id = '33333333-aaaa-4aaa-8aaa-aaaaaaaa0003';

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10101010-1010-4010-8010-101010101010', true);
select test.assert((select count(id) = 0 from public.assets
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001'),
  '期限切れentryのassetは物理削除前からRLSで非表示');
select set_config('request.jwt.claim.sub', '40404040-4040-4040-8040-404040404040', true);
select test.assert((select count(id) = 1 from public.assets), '本人は自分の有効assetだけ読める');
select test.assert((select count(id) = 0 from public.assets
  where id = '55555555-aaaa-4aaa-8aaa-555555550001'), '有効entryでも他owner assetは非表示');
reset role;
set local role service_role;

select public.claim_retention_cleanup(10) as first_claim \gset
select test.assert(jsonb_array_length(:'first_claim'::jsonb) = 1
  and (:'first_claim'::jsonb -> 0 ->> 'entry_id') = :'archived_entry_id'
  and (:'first_claim'::jsonb -> 0 -> 'object_paths') = jsonb_build_array(
    '10101010-1010-4010-8010-101010101010/11111111-aaaa-4aaa-8aaa-aaaaaaaa0001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001.png'),
  'activeなqueued/runningを避け、期限切れentryと正規pathだけclaim');
select (:'first_claim'::jsonb -> 0 ->> 'claim_token') as first_claim_token \gset
reset role;
update private.retention_cleanup_leases set lease_expires_at = statement_timestamp() - interval '1 second'
where entry_id = :'archived_entry_id';
set local role service_role;
select test.assert(not public.finalize_retention_cleanup(:'archived_entry_id', :'first_claim_token', true),
  'lease期限後のfinalizeを拒否');
select public.claim_retention_cleanup(10) as second_claim \gset
select (:'second_claim'::jsonb -> 0 ->> 'claim_token') as second_claim_token \gset
select test.assert(:'second_claim_token' <> :'first_claim_token', '再claimでtokenを更新');
select test.assert(not public.finalize_retention_cleanup(:'archived_entry_id', :'second_claim_token', false),
  'Storage成功を確認していないfinalizeを拒否');

select (select count || ':' || committed_micro_usd from private.quota_counters
  where scope = 'global_total') as quota_before_purge \gset
select public.finalize_retention_cleanup(:'archived_entry_id', :'second_claim_token', true)
  as archived_finalized \gset
select test.assert(:'archived_finalized'::boolean, 'Storage成功後に期限切れentryを削除');
select test.assert(:'quota_before_purge' = (select count || ':' || committed_micro_usd
  from private.quota_counters where scope = 'global_total'), '物理削除でquota counterを変更しない');
reset role;
select test.assert(not exists (select 1 from public.entries where id = :'archived_entry_id')
  and not exists (select 1 from public.generations where id = '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001')
  and not exists (select 1 from public.assets where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001')
  and not exists (select 1 from private.reservations
    where generation_id = '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001')
  and not exists (select 1 from private.provider_attempts
    where generation_id = '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001')
  and exists (select 1 from private.entry_tombstones
    where owner_id = '10101010-1010-4010-8010-101010101010'
      and create_request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and entry_id = :'archived_entry_id'), 'asset・job・entryを物理削除しtombstoneを保持');
select test.assert((select reservation_present and reserved_day = :'today'::date - 1
  and max_cost_micro_usd = 17 and reservation_state = 'held'
  from private.retained_generation_ledger
  where generation_id = '11111111-aaaa-4aaa-8aaa-aaaaaaaa0001')
  and (select request_id = 'fictional-provider-request' and state = 'unknown'
    from private.retained_provider_attempts
    where attempt_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001')
  and not exists (select 1 from information_schema.columns
    where table_schema = 'private' and table_name = 'retained_generation_ledger'
      and column_name in ('input_snapshot', 'model_profile_snapshot', 'comic_json')),
  'held台帳・provider request IDだけを保持し本文やscriptを含めない');
set local role service_role;
select test.assert(public.finalize_retention_cleanup(:'archived_entry_id', :'second_claim_token', true),
  '同じfinalizeの再送は成功扱い');
select test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
  '10101010-1010-4010-8010-101010101010', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  :'today'::date, '古い作成要求の架空日記', 'v1'), 'P0001', 'NOT_FOUND');

select test.assert(jsonb_array_length(public.claim_retention_cleanup(10)) = 0,
  'queued/runningをsettlementする前は削除対象にしない');
select public.fail_or_hold_generation('22222222-aaaa-4aaa-8aaa-aaaaaaaa0002', null, 'cancelled')
  as queued_settlement \gset
select public.fail_or_hold_generation('33333333-aaaa-4aaa-8aaa-aaaaaaaa0003',
  'cccccccc-dddd-4ddd-8ddd-cccccccccccc', 'cancelled') as running_settlement \gset
select test.assert(:'queued_settlement'::jsonb ->> 'status' = 'cancelled'
  and :'queued_settlement'::jsonb ->> 'reservation_state' = 'released'
  and :'running_settlement'::jsonb ->> 'status' = 'cancelled'
  and :'running_settlement'::jsonb ->> 'reservation_state' = 'released',
  'Queue settlement完了後にactive jobがterminalになる');
select public.claim_retention_cleanup(10) as active_claims \gset
select test.assert(jsonb_array_length(:'active_claims'::jsonb) = 2,
  'settlement完了後にqueued/running entryをclaim');
select (:'active_claims'::jsonb -> 0 ->> 'entry_id') as first_active_entry \gset
select (:'active_claims'::jsonb -> 0 ->> 'claim_token') as first_active_token \gset
select (:'active_claims'::jsonb -> 1 ->> 'entry_id') as second_active_entry \gset
select (:'active_claims'::jsonb -> 1 ->> 'claim_token') as second_active_token \gset
select (select count || ':' || committed_micro_usd from private.quota_counters
  where scope = 'global_total') as quota_before_active_purge \gset
select test.assert(public.finalize_retention_cleanup(:'first_active_entry', :'first_active_token', true)
  and public.finalize_retention_cleanup(:'second_active_entry', :'second_active_token', true),
  '画像のないterminal entryも冪等に物理削除');
select test.assert(:'quota_before_active_purge' = (select count || ':' || committed_micro_usd
  from private.quota_counters where scope = 'global_total'), 'settlement後の削除でもcounter不変');

set local role anon;
select test.expect_error('select id from public.assets', '42501');
select test.expect_error('select public.finalize_retention_cleanup(null,null,true)', '42501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '40404040-4040-4040-8040-404040404040', true);
select test.assert((select count(id) = 1 from public.assets), 'asset RLSはownerかつ有効entryだけを表示');
select test.assert((select count(id) = 0 from public.assets
  where id = '55555555-aaaa-4aaa-8aaa-555555550001'), '他ownerのassetは非表示');
select test.expect_error('select object_path from public.assets', '42501');
select test.assert(not has_column_privilege('authenticated', 'public.assets', 'owner_id', 'SELECT')
  and not has_column_privilege('authenticated', 'public.assets', 'object_path', 'SELECT'),
  'authenticatedにはasset ownerとobject pathを公開しない');
select test.expect_error('delete from public.assets where false', '42501');
select test.expect_error('select public.claim_retention_cleanup(1)', '42501');
rollback;
