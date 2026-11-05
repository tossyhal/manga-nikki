\set ON_ERROR_STOP on
begin;
create schema test;
grant usage on schema test to service_role;
create function test.assert(ok boolean, label text) returns void
language plpgsql security invoker as $$
begin
  if ok is distinct from true then raise exception '検証失敗: %', label; end if;
end;
$$;
create function test.expect_error(command text, expected_state text, expected_message text)
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
  perform test.assert(actual_message = expected_message, '期待した業務エラーで拒否');
end;
$$;
grant execute on all functions in schema test to service_role;

insert into auth.users(id) values
  ('a1010101-0101-4101-8101-010101010101'),
  ('a2020202-0202-4202-8202-020202020202'),
  ('a3030303-0303-4303-8303-030303030303'),
  ('a4040404-0404-4404-8404-040404040404'),
  ('a5050505-0505-4505-8505-050505050505');

delete from private.entry_creation_owner_daily;
delete from private.entry_creation_global_daily;
set local time zone 'Pacific/Honolulu';

select test.assert(
  (select prosecdef from pg_catalog.pg_proc
    where oid = 'public.create_entry(uuid,uuid,date,text,text)'::regprocedure)
    and has_function_privilege('service_role',
      'public.create_entry(uuid,uuid,date,text,text)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.create_entry(uuid,uuid,date,text,text)', 'EXECUTE')
    and not has_table_privilege('service_role', 'private.entry_creation_global_daily', 'SELECT')
    and not has_table_privilege('service_role', 'private.entry_creation_owner_daily', 'INSERT'),
  'create_entryだけがprivate counterを更新し、anon / service_roleからcounterを直接読書きできない');

insert into private.entry_creation_global_daily (day_key, creation_count)
  values ((statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, 12);
insert into private.entry_creation_owner_daily (owner_id, day_key, creation_count)
  values ('a1010101-0101-4101-8101-010101010101',
    (statement_timestamp() at time zone 'Asia/Tokyo')::date - 1, 12);

set local role service_role;
do $$
declare
  actor uuid := 'a1010101-0101-4101-8101-010101010101';
  request uuid := 'a1111111-1111-4111-8111-111111111111';
  second_request uuid := 'a1212121-1212-4212-8212-121212121212';
  today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  first public.entries;
  replay public.entries;
  second public.entries;
begin
  first := public.create_entry(actor, request, today, '作成時の架空日記', 'v1');
  perform public.update_entry(actor, first.id, 1, today, '編集後の架空日記');
  replay := public.create_entry(actor, request, today, '作成時の架空日記', 'v1');
  perform test.assert(replay.id = first.id and replay.revision = 2
    and replay.body = '編集後の架空日記', '編集後の元要求再送は更新済み行を返す');
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, request, today, '同じキーで別の架空日記', 'v1'), 'P0001', 'IDEMPOTENCY_CONFLICT');
  perform public.request_entry_deletion(actor, first.id);
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, request, today, '作成時の架空日記', 'v1'), 'P0001', 'NOT_FOUND');
  second := public.create_entry(actor, second_request, today, '削除後の正常な再作成', 'v1');
  perform test.assert(second.id <> first.id, '別の作成要求で削除後に再作成できる');
end;
$$;
reset role;
select test.assert(
  (select count(*) = 0 from private.entry_creation_global_daily
    where day_key < (statement_timestamp() at time zone 'Asia/Tokyo')::date)
  and (select count(*) = 0 from private.entry_creation_owner_daily
    where day_key < (statement_timestamp() at time zone 'Asia/Tokyo')::date)
  and (select creation_count = 2 from private.entry_creation_global_daily
    where day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date)
  and (select creation_count = 2 from private.entry_creation_owner_daily
    where owner_id = 'a1010101-0101-4101-8101-010101010101'
      and day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date),
  'JST日付で一意な新規作成だけを計上し、編集・冪等再送・削除では計上しない');

insert into public.entries (
  owner_id, create_request_id, create_request_hash, diary_date, body, consent_version,
  deleted_at, expires_at
)
select 'a4040404-0404-4404-8404-040404040404', gen_random_uuid(),
  pg_catalog.sha256(pg_catalog.convert_to('retained-fixture', 'UTF8')),
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, '削除済みの架空保持fixture', 'v1',
  pg_catalog.clock_timestamp() - interval '100 years',
  pg_catalog.clock_timestamp() - interval '1 day'
from pg_catalog.generate_series(1, 100);
set local role service_role;
do $$
declare
  actor uuid := 'a4040404-0404-4404-8404-040404040404';
  today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  claims jsonb;
  claim jsonb;
  cleaned boolean := false;
begin
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today, '保持上限の確認', 'v1'),
    'P0001', 'ENTRY_OWNER_RETAINED_LIMIT_REACHED');
  claims := public.claim_retention_cleanup(10);
  for claim in select value from pg_catalog.jsonb_array_elements(claims)
    where value ->> 'owner_id' = actor::text
  loop
    cleaned := public.finalize_retention_cleanup(
      (claim ->> 'entry_id')::uuid, (claim ->> 'claim_token')::uuid, true);
    exit when cleaned;
  end loop;
  perform test.assert(cleaned, 'Storage削除確認後の物理回収を実行できる');
  perform public.create_entry(actor, gen_random_uuid(), today, '物理回収後の架空日記', 'v1');
end;
$$;
reset role;
select test.assert((select count(*) = 100 from public.entries
  where owner_id = 'a4040404-0404-4404-8404-040404040404'),
  'owner retained上限100件は未回収行を数え、1件の物理回収後に作成できる');

create temporary table entry_limit_seed_owners (owner_id uuid primary key) on commit drop;
insert into entry_limit_seed_owners (owner_id)
select gen_random_uuid() from pg_catalog.generate_series(1, 51);
insert into auth.users(id) select owner_id from entry_limit_seed_owners;
do $$
declare
  today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  now_at timestamptz := pg_catalog.clock_timestamp();
  seed_owners uuid[];
  rows_to_seed integer;
begin
  select pg_catalog.array_agg(owner_id order by owner_id) into seed_owners
    from entry_limit_seed_owners;
  select 4999 - count(*)::integer into rows_to_seed from public.entries;
  if rows_to_seed < 0 then raise exception 'global retained fixture exceeded target'; end if;
  insert into public.entries (
    owner_id, create_request_id, create_request_hash, diary_date, body, consent_version,
    deleted_at, expires_at
  )
  select seed_owners[((series.n - 1) % pg_catalog.cardinality(seed_owners)) + 1],
    pg_catalog.gen_random_uuid(), pg_catalog.sha256(pg_catalog.convert_to('global-fixture', 'UTF8')),
    today, '未回収の架空global fixture', 'v1', now_at - interval '100 years',
    now_at - interval '1 day'
  from pg_catalog.generate_series(1, rows_to_seed) as series(n);
end;
$$;
delete from private.entry_creation_global_daily;
insert into private.entry_creation_global_daily (day_key, creation_count)
  values ((statement_timestamp() at time zone 'Asia/Tokyo')::date, 0);
set local role service_role;
do $$
declare
  actor uuid := 'a5050505-0505-4505-8505-050505050505';
  request uuid := 'a5151515-1515-4515-8515-151515151515';
  today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  first public.entries;
  replay public.entries;
  claims jsonb;
  claim jsonb;
  cleaned boolean := false;
begin
  perform test.assert((select count(*) = 4999 from public.entries),
    'global retained上限の直前までfixtureを配置');
  first := public.create_entry(actor, request, today, 'global上限直前の架空日記', 'v1');
  perform test.assert((select count(*) = 5000 from public.entries),
    '最後のglobal retained枠を原子的に使う');
  replay := public.create_entry(actor, request, today, 'global上限直前の架空日記', 'v1');
  perform test.assert(replay.id = first.id, 'global retained上限到達後も冪等再送を返す');
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today, 'global上限超過の架空日記', 'v1'),
    'P0001', 'ENTRY_GLOBAL_RETAINED_LIMIT_REACHED');
  perform public.request_entry_deletion(actor, first.id);
  claims := public.claim_retention_cleanup(1);
  claim := claims -> 0;
  perform test.assert(claim is not null and public.finalize_retention_cleanup(
    (claim ->> 'entry_id')::uuid, (claim ->> 'claim_token')::uuid, true),
    'daily cleanupのStorage確認後に1行を物理回収');
  perform public.create_entry(actor, gen_random_uuid(), today, '回収後の再作成', 'v1');
end;
$$;
reset role;
select test.assert((select count(*) = 5000 from public.entries),
  'global retained上限5000は物理回収後に新しい行を許可');

set local role service_role;
do $$
declare
  claims jsonb := public.claim_retention_cleanup(10);
  claim jsonb;
  cleaned_count integer := 0;
begin
  for claim in select value from pg_catalog.jsonb_array_elements(claims) loop
    if public.finalize_retention_cleanup(
      (claim ->> 'entry_id')::uuid, (claim ->> 'claim_token')::uuid, true) then
      cleaned_count := cleaned_count + 1;
    end if;
    exit when cleaned_count = 3;
  end loop;
  perform test.assert(cleaned_count = 3, '日次cleanup枠内で保持上限のfixtureを複数回収');
end;
$$;
reset role;
select test.assert((select count(*) = 4997 from public.entries),
  '日次rate limitの検証前にcleanupでglobal容量を3行分空ける');

delete from private.entry_creation_owner_daily
  where owner_id = 'a2020202-0202-4202-8202-020202020202';
insert into private.entry_creation_owner_daily (owner_id, day_key, creation_count)
  values ('a2020202-0202-4202-8202-020202020202',
    (statement_timestamp() at time zone 'Asia/Tokyo')::date, 49);
set local role service_role;
do $$
declare
  actor uuid := 'a2020202-0202-4202-8202-020202020202';
  request uuid := 'a2121212-1212-4212-8212-212121212121';
  today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  first public.entries;
  replay public.entries;
begin
  first := public.create_entry(actor, request, today, 'owner日次上限直前', 'v1');
  replay := public.create_entry(actor, request, today, 'owner日次上限直前', 'v1');
  perform test.assert(replay.id = first.id, '日次上限到達時も同一要求は冪等');
  perform public.request_entry_deletion(actor, first.id);
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today, 'owner日次上限超過', 'v1'),
    'P0001', 'ENTRY_OWNER_CREATE_LIMIT_REACHED');
end;
$$;
reset role;
select test.assert((select creation_count = 50 from private.entry_creation_owner_daily
  where owner_id = 'a2020202-0202-4202-8202-020202020202'
    and day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date),
  'ownerの日次上限50件は新規作成だけを計上する');

delete from private.entry_creation_global_daily;
insert into private.entry_creation_global_daily (day_key, creation_count)
  values ((statement_timestamp() at time zone 'Asia/Tokyo')::date, 999);
set local role service_role;
do $$
declare
  actor uuid := 'a3030303-0303-4303-8303-030303030303';
  request uuid := 'a3131313-1313-4313-8313-131313131313';
  today date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  first public.entries;
  replay public.entries;
begin
  first := public.create_entry(actor, request, today, 'global日次上限直前', 'v1');
  replay := public.create_entry(actor, request, today, 'global日次上限直前', 'v1');
  perform test.assert(replay.id = first.id, 'global日次上限到達時も同一要求は冪等');
  perform public.request_entry_deletion(actor, first.id);
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today, 'global日次上限超過', 'v1'),
    'P0001', 'ENTRY_GLOBAL_CREATE_LIMIT_REACHED');
end;
$$;
reset role;
select test.assert((select creation_count = 1000 from private.entry_creation_global_daily
  where day_key = (statement_timestamp() at time zone 'Asia/Tokyo')::date),
  'globalの日次上限1000件は削除後も新規作成だけを計上する');
rollback;
