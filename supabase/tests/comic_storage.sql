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
create function test.valid_script()
returns jsonb language sql immutable security invoker set search_path = ''
as $$
  select '{"title":"隔離DB用の架空漫画","panels":[
    {"index":1,"scene":"架空の朝食","caption":"朝食を食べた。","dialogue":""},
    {"index":2,"scene":"架空の読書","caption":"本を読んだ。","dialogue":""},
    {"index":3,"scene":"架空の帰路","caption":"帰り道を歩いた。","dialogue":""},
    {"index":4,"scene":"架空の猫","caption":"猫を見かけた。","dialogue":""}]}'::jsonb;
$$;
create function test.valid_asset_metadata()
returns jsonb language sql immutable security invoker set search_path = ''
as $$
  select pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('index', 1, 'media_type', 'image/png', 'byte_size', 1200,
      'width', 1024, 'height', 1024, 'sha256', pg_catalog.repeat('a', 64)),
    pg_catalog.jsonb_build_object('index', 2, 'media_type', 'image/jpeg', 'byte_size', 1300,
      'width', 1024, 'height', 1024, 'sha256', pg_catalog.repeat('b', 64)),
    pg_catalog.jsonb_build_object('index', 3, 'media_type', 'image/webp', 'byte_size', 1400,
      'width', 1024, 'height', 1024, 'sha256', pg_catalog.repeat('c', 64)),
    pg_catalog.jsonb_build_object('index', 4, 'media_type', 'image/png', 'byte_size', 1500,
      'width', 1024, 'height', 1024, 'sha256', pg_catalog.repeat('d', 64))
  );
$$;
create function test.comic_save_task_exists(p_generation_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from private.comic_save_tasks t
    where t.generation_id = p_generation_id);
$$;
create function test.retained_reservation_state(p_generation_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select l.reservation_state from private.retained_generation_ledger l
  where l.generation_id = p_generation_id;
$$;
create table test.fixtures (
  label text primary key,
  generation_id uuid not null,
  entry_id uuid not null,
  owner_id uuid not null,
  diary_date date not null,
  claim_token uuid not null,
  save_claim_token uuid
);
grant select on test.fixtures to service_role;
create function test.make_saving_fixture(p_label text, p_start_task boolean default false)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid := pg_catalog.md5('comic-save-owner:' || p_label)::uuid;
  v_entry public.entries;
  v_receipt jsonb;
  v_claim jsonb;
  v_generation_id uuid;
  v_claim_token uuid;
  v_attempt_id uuid;
  v_save jsonb;
  v_save_token uuid;
  v_diary_date date := (pg_catalog.statement_timestamp() at time zone 'Asia/Tokyo')::date;
  v_stage text;
  v_index integer;
begin
  insert into auth.users(id) values (v_owner) on conflict (id) do nothing;
  v_entry := public.create_entry(
    v_owner, pg_catalog.md5('comic-save-entry:' || p_label)::uuid,
    v_diary_date, '漫画保存RPC検証用の架空日記', 'v1'
  );
  v_receipt := public.reserve_openai_generation(
    v_owner, v_entry.id, v_entry.revision,
    pg_catalog.md5('comic-save-idempotency:' || p_label)::uuid, true
  );
  v_generation_id := (v_receipt ->> 'generation_id')::uuid;
  v_claim := public.claim_generation(v_generation_id);
  v_claim_token := (v_claim ->> 'claim_token')::uuid;
  for v_stage, v_index in
    select 'script'::text, 1
    union all
    select 'images'::text, pg_catalog.generate_series(1, 4)
  loop
    v_attempt_id := (public.begin_provider_attempt(
      v_generation_id, v_claim_token, v_stage, v_index, true
    ) ->> 'attempt_id')::uuid;
    perform public.finish_provider_attempt(
      v_generation_id, v_claim_token, v_attempt_id, 'succeeded',
      'fictional-comic-save-' || p_label || '-' || v_stage || '-' || v_index::text
    );
  end loop;
  perform public.mark_generation_saving(v_generation_id, v_claim_token);

  insert into test.fixtures (label, generation_id, entry_id, owner_id, diary_date, claim_token)
  values (p_label, v_generation_id, v_entry.id, v_owner, v_diary_date, v_claim_token);
  if p_start_task then
    v_save := public.begin_comic_save_task(
      v_generation_id, v_owner, v_entry.revision, v_diary_date, v_claim_token,
      'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
      test.valid_script(), test.valid_asset_metadata()
    );
    v_save_token := (v_save ->> 'save_claim_token')::uuid;
    update test.fixtures set save_claim_token = v_save_token where label = p_label;
  else
    v_save := null;
  end if;
  return pg_catalog.jsonb_build_object(
    'generation_id', v_generation_id,
    'entry_id', v_entry.id,
    'owner_id', v_owner,
    'diary_date', v_diary_date,
    'claim_token', v_claim_token,
    'save_claim_token', v_save_token,
    'save', v_save
  );
end;
$$;
grant execute on all functions in schema test to anon, authenticated, service_role;

update private.generation_policy set enabled = true, user_daily_limit = 100,
  global_daily_limit = 1000, global_total_limit = 1000, budget_micro_usd = 100000,
  model_profile_json = test.openai_profile(17)
where id = 1;

set local role service_role;
select test.make_saving_fixture('complete', true) as complete_fixture \gset
select (:'complete_fixture'::jsonb ->> 'generation_id') as complete_generation \gset
select (:'complete_fixture'::jsonb ->> 'entry_id') as complete_entry \gset
select (:'complete_fixture'::jsonb ->> 'owner_id') as complete_owner \gset
select (:'complete_fixture'::jsonb ->> 'diary_date') as complete_date \gset
select (:'complete_fixture'::jsonb ->> 'claim_token') as complete_claim \gset
select (:'complete_fixture'::jsonb ->> 'save_claim_token') as complete_save_claim \gset
select (:'complete_fixture'::jsonb -> 'save') as complete_save \gset

select test.assert(:'complete_save'::jsonb ->> 'status' = 'claimed'
  and :'complete_save'::jsonb -> 'task' ->> 'owner_id' = :'complete_owner'
  and :'complete_save'::jsonb -> 'task' ->> 'entry_id' = :'complete_entry'
  and (:'complete_save'::jsonb -> 'task' ->> 'entry_revision')::integer = 1
  and (:'complete_save'::jsonb -> 'task' ->> 'diary_date')::date = :'complete_date'::date
  and :'complete_save'::jsonb -> 'task' ->> 'claim_token' = :'complete_claim'
  and :'complete_save'::jsonb -> 'task' ->> 'profile_id' =
    'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1'
  and jsonb_array_length(:'complete_save'::jsonb -> 'task' -> 'asset_metadata') = 4
  and :'complete_save'::jsonb -> 'task' -> 'comic_draft' -> 'visual' ->> 'kind' = 'panels',
  '初回保存taskはowner/job/revision/date/profile/脚本/漫画下書き/4assetsをdurable化');
select test.assert(has_table_privilege('service_role', 'private.comic_save_tasks', 'SELECT') is false
  and has_table_privilege('service_role', 'private.comic_save_tasks', 'INSERT') is false
  and has_table_privilege('service_role', 'private.comic_save_tasks', 'UPDATE') is false
  and has_table_privilege('service_role', 'private.comic_save_tasks', 'DELETE') is false
  and has_function_privilege('service_role',
    'public.begin_comic_save_task(uuid,uuid,integer,date,uuid,text,jsonb,jsonb)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'private.settle_comic_save_locked(uuid,text,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.begin_comic_save_task(uuid,uuid,integer,date,uuid,text,jsonb,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.complete_comic_save(uuid,uuid,integer,date,uuid,uuid,text,jsonb,jsonb)', 'EXECUTE'),
  'task直アクセス不可・保存RPCはservice_role限定');
select test.expect_error('select * from private.comic_save_tasks', '42501');
select test.expect_error(
  'select private.settle_comic_save_locked(gen_random_uuid(),''failed'',clock_timestamp())', '42501');
select test.assert((:'complete_save'::jsonb ->> 'lease_expires_at')::timestamptz >
  pg_catalog.clock_timestamp()
  and (:'complete_save'::jsonb ->> 'lease_expires_at')::timestamptz <=
    pg_catalog.clock_timestamp() + interval '121 seconds',
  '保存claimは独立tokenと120秒lease');

select public.begin_comic_save_task(:'complete_generation'::uuid, :'complete_owner'::uuid, 1,
  :'complete_date'::date, :'complete_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  test.valid_script(), test.valid_asset_metadata()) as duplicate_save \gset
select test.assert(:'duplicate_save'::jsonb ->> 'status' = 'pending'
  and not (:'duplicate_save'::jsonb ? 'save_claim_token'),
  '有効な保存leaseがあれば同taskの二重claimを拒否');
select test.expect_error(format(
  'select public.begin_comic_save_task(%L,%L,1,%L,%L,%L,%L::jsonb,%L::jsonb)',
  :'complete_generation'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  :'complete_date'::date, :'complete_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  test.valid_script()::text, test.valid_asset_metadata()::text), 'P0001', 'NOT_FOUND');
select test.expect_error(format(
  'select public.begin_comic_save_task(%L,%L,1,%L,%L,%L,%L::jsonb,%L::jsonb)',
  :'complete_generation'::uuid, :'complete_owner'::uuid,
  :'complete_date'::date, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  test.valid_script()::text, test.valid_asset_metadata()::text), 'P0001', 'CLAIM_LOST');
select test.expect_error(format(
  'select public.begin_comic_save_task(%L,%L,1,%L,%L,%L,%L::jsonb,%L::jsonb)',
  :'complete_generation'::uuid, :'complete_owner'::uuid, :'complete_date'::date,
  :'complete_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  test.valid_script()::text,
  pg_catalog.jsonb_set(test.valid_asset_metadata(), '{0,index}', '2'::jsonb)::text),
  'P0001', 'INVALID_ASSET_METADATA');
select test.expect_error(format(
  'select public.begin_comic_save_task(%L,%L,1,%L,%L,%L,%L::jsonb,%L::jsonb)',
  :'complete_generation'::uuid, :'complete_owner'::uuid, :'complete_date'::date,
  :'complete_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  test.valid_script()::text,
  pg_catalog.jsonb_set(test.valid_asset_metadata(), '{0,byte_size}', '8388609'::jsonb)::text),
  'P0001', 'INVALID_ASSET_METADATA');
select test.expect_error(format(
  'select public.begin_comic_save_task(%L,%L,1,%L,%L,%L,%L::jsonb,%L::jsonb)',
  :'complete_generation'::uuid, :'complete_owner'::uuid, :'complete_date'::date,
  :'complete_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  test.valid_script()::text,
  pg_catalog.jsonb_set(test.valid_asset_metadata(), '{0,width}', '2049'::jsonb)::text),
  'P0001', 'INVALID_ASSET_METADATA');

select test.assert(
  (:'complete_save'::jsonb -> 'task' -> 'asset_metadata' -> 0 ->> 'asset_id') ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$'
  and (:'complete_save'::jsonb -> 'task' -> 'asset_metadata' -> 0 ->> 'object_path') =
    :'complete_owner' || '/' || :'complete_generation' || '/' ||
      (:'complete_save'::jsonb -> 'task' -> 'asset_metadata' -> 0 ->> 'asset_id') || '.png'
  and (:'complete_save'::jsonb -> 'task' -> 'comic_draft' -> 'visual' -> 'assetIds' ->> 0) =
    (:'complete_save'::jsonb -> 'task' -> 'asset_metadata' -> 0 ->> 'asset_id'),
  'asset IDはRFC variant/versionを持つ決定値でpath/漫画コマ順が一致');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'complete_owner', true);
select test.assert((select count(*) = 0 from public.assets),
  '未完了のsave taskやplanned imageをasset一覧へ公開しない');
reset role;
set local role service_role;

select test.expect_error(format(
  'select public.complete_comic_save(%L,%L,1,%L,%L,%L,%L,%L::jsonb,%L::jsonb)',
  :'complete_generation'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  :'complete_date'::date, :'complete_claim'::uuid, :'complete_save_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  (:'complete_save'::jsonb -> 'task' -> 'comic_draft')::text,
  test.valid_asset_metadata()::text), 'P0001', 'NOT_FOUND');
select test.expect_error(format(
  'select public.complete_comic_save(%L,%L,1,%L,%L,%L,%L,%L::jsonb,%L::jsonb)',
  :'complete_generation'::uuid, :'complete_owner'::uuid, :'complete_date'::date,
  :'complete_claim'::uuid, :'complete_save_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  jsonb_set(:'complete_save'::jsonb -> 'task' -> 'comic_draft',
    '{visual,assetIds,0}', '"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"'::jsonb)::text,
  test.valid_asset_metadata()::text), 'P0001', 'COMIC_ASSET_MISMATCH');
select test.expect_error(format(
  'select public.complete_comic_save(%L,%L,1,%L,%L,%L,%L,%L::jsonb,%L::jsonb)',
  :'complete_generation'::uuid, :'complete_owner'::uuid, :'complete_date'::date,
  :'complete_claim'::uuid, :'complete_save_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  (:'complete_save'::jsonb -> 'task' -> 'comic_draft')::text,
  jsonb_build_array(
    test.valid_asset_metadata() -> 1,
    test.valid_asset_metadata() -> 0,
    test.valid_asset_metadata() -> 2,
    test.valid_asset_metadata() -> 3)::text), 'P0001', 'INVALID_ASSET_METADATA');

select count || ':' || committed_micro_usd as quota_before_complete
from private.quota_counters where scope = 'global_total' \gset
select public.complete_comic_save(
  :'complete_generation'::uuid, :'complete_owner'::uuid, 1, :'complete_date'::date,
  :'complete_claim'::uuid, :'complete_save_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  :'complete_save'::jsonb -> 'task' -> 'comic_draft', test.valid_asset_metadata()
) as completed_save \gset
select test.assert(:'completed_save'::jsonb ->> 'status' = 'succeeded'
  and :'completed_save'::jsonb -> 'comic_json' =
    :'complete_save'::jsonb -> 'task' -> 'comic_draft'
  and jsonb_array_length(:'completed_save'::jsonb -> 'asset_ids') = 4
  and (select status = 'succeeded' and stage is null and comic_json =
    :'complete_save'::jsonb -> 'task' -> 'comic_draft'
    from public.generations where id = :'complete_generation'::uuid)
  and (select state = 'consumed' from private.reservations
    where generation_id = :'complete_generation'::uuid)
  and (select count(*) = 4 from public.assets where generation_id = :'complete_generation'::uuid)
  and not test.comic_save_task_exists(:'complete_generation'::uuid)
  and (select count || ':' || committed_micro_usd from private.quota_counters
    where scope = 'global_total') = :'quota_before_complete',
  'succeeded・assets・comic_json・consumedを一括確定し予約カウンターは返さない');
select public.complete_comic_save(
  :'complete_generation'::uuid, :'complete_owner'::uuid, 1, :'complete_date'::date,
  :'complete_claim'::uuid, :'complete_save_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  :'complete_save'::jsonb -> 'task' -> 'comic_draft', test.valid_asset_metadata()
) as repeated_completion \gset
select test.assert(:'repeated_completion'::jsonb ->> 'status' = 'succeeded'
  and :'repeated_completion'::jsonb -> 'asset_ids' = :'completed_save'::jsonb -> 'asset_ids',
  'DB完了RPCを同じasset/comic/tokenで再送しても冪等');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'complete_owner', true);
select test.assert((select count(*) = 4 from public.assets), '本人には成功後の4assetsだけを公開');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select test.assert((select count(*) = 0 from public.assets), '他ownerには成功assetを公開しない');
reset role;
set local role service_role;

select public.request_entry_deletion(:'complete_owner'::uuid, :'complete_entry'::uuid);
select public.claim_retention_cleanup(10) as completed_cleanup \gset
select public.finalize_retention_cleanup(
  :'complete_entry'::uuid, (:'completed_cleanup'::jsonb -> 0 ->> 'claim_token')::uuid, true
) as completed_purged \gset
reset role;
select test.assert(:'completed_purged'::boolean
  and (select count(*) = 4 from private.storage_deletion_outbox
    where object_path in (
      select asset.value ->> 'object_path'
      from jsonb_array_elements(:'complete_save'::jsonb -> 'task' -> 'asset_metadata') asset(value)
    ))
  and not exists (select 1 from public.assets
    where generation_id = :'complete_generation'::uuid),
  'purgeは完了済みpublic.assetsのStorage pathもoutboxへ移す');
set local role service_role;

select test.make_saving_fixture('recovery_missing_task', false) as missing_fixture \gset
select (:'missing_fixture'::jsonb ->> 'generation_id') as missing_generation \gset
select (:'missing_fixture'::jsonb ->> 'owner_id') as missing_owner \gset
select (:'missing_fixture'::jsonb ->> 'entry_id') as missing_entry \gset
select count || ':' || committed_micro_usd as quota_before_missing
from private.quota_counters where scope = 'global_total' \gset
reset role;
update public.generations set deadline_at = pg_catalog.clock_timestamp() - interval '1 minute'
where id = :'missing_generation'::uuid;
set local role service_role;
select test.assert(public.begin_generation_save_recovery(:'missing_generation'::uuid),
  '24h内のsaving jobを復旧対象へlease');
select public.claim_comic_save_recovery(:'missing_generation'::uuid) as missing_recovery \gset
select test.assert(:'missing_recovery'::jsonb ->> 'status' = 'failed'
  and (select status = 'failed' from public.generations where id = :'missing_generation'::uuid)
  and (select state = 'consumed' from private.reservations
    where generation_id = :'missing_generation'::uuid)
  and (select count || ':' || committed_micro_usd from private.quota_counters
    where scope = 'global_total') = :'quota_before_missing',
  'durable task欠落はAI再実行せずfailed/consumed/no-refund');

select test.make_saving_fixture('recovery_bytes_missing', true) as bytes_fixture \gset
select (:'bytes_fixture'::jsonb ->> 'generation_id') as bytes_generation \gset
select (:'bytes_fixture'::jsonb ->> 'owner_id') as bytes_owner \gset
select (:'bytes_fixture'::jsonb ->> 'entry_id') as bytes_entry \gset
select (:'bytes_fixture'::jsonb ->> 'claim_token') as bytes_claim \gset
select (:'bytes_fixture'::jsonb ->> 'save_claim_token') as bytes_initial_save_claim \gset
select count || ':' || committed_micro_usd as quota_before_missing_bytes
from private.quota_counters where scope = 'global_total' \gset
reset role;
update public.generations set deadline_at = pg_catalog.clock_timestamp() - interval '1 minute'
where id = :'bytes_generation'::uuid;
update private.comic_save_tasks set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
where generation_id = :'bytes_generation'::uuid;
set local role service_role;
select public.claim_comic_save_recovery(:'bytes_generation'::uuid) as recovery_claim \gset
select test.assert(:'recovery_claim'::jsonb ->> 'status' = 'claimed'
  and (:'recovery_claim'::jsonb -> 'task' ->> 'claim_token') = :'bytes_claim'
  and (:'recovery_claim'::jsonb -> 'task' ->> 'owner_id') = :'bytes_owner',
  '復旧leaseは元provider claimを維持して新save tokenを発行');
select public.claim_comic_save_recovery(:'bytes_generation'::uuid) as recovery_race \gset
select test.assert(:'recovery_race'::jsonb ->> 'status' = 'pending',
  'active save lease中の復旧二重claimを拒否');
select count || ':' || committed_micro_usd as quota_before_missing_bytes_fail
from private.quota_counters where scope = 'global_total' \gset
select public.fail_comic_save(
  :'bytes_generation'::uuid, :'bytes_claim'::uuid,
  (:'recovery_claim'::jsonb ->> 'save_claim_token')::uuid
) as bytes_missing_result \gset
select test.assert(:'bytes_missing_result'::jsonb ->> 'status' = 'failed'
  and (select state = 'consumed' from private.reservations
    where generation_id = :'bytes_generation'::uuid)
  and (select count || ':' || committed_micro_usd from private.quota_counters
    where scope = 'global_total') = :'quota_before_missing_bytes_fail',
  'missing Storage bytesはfailed/consumedとなり予約返金なし');

select test.make_saving_fixture('recovery_24h_boundary', true) as boundary_fixture \gset
select (:'boundary_fixture'::jsonb ->> 'generation_id') as boundary_generation \gset
select (:'boundary_fixture'::jsonb ->> 'owner_id') as boundary_owner \gset
select (:'boundary_fixture'::jsonb ->> 'entry_id') as boundary_entry \gset
select (:'boundary_fixture'::jsonb ->> 'claim_token') as boundary_claim \gset
reset role;
update public.generations set deadline_at = pg_catalog.clock_timestamp() - interval '24 hours' + interval '30 seconds'
where id = :'boundary_generation'::uuid;
update private.comic_save_tasks set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
where generation_id = :'boundary_generation'::uuid;
set local role service_role;
select public.claim_comic_save_recovery(:'boundary_generation'::uuid) as boundary_recovery \gset
select test.assert(:'boundary_recovery'::jsonb ->> 'status' = 'claimed'
  and (:'boundary_recovery'::jsonb ->> 'lease_expires_at')::timestamptz <=
    (select deadline_at + interval '24 hours' from public.generations
      where id = :'boundary_generation'::uuid),
  '24時間期限直前の復旧leaseは期限上限で切る');
reset role;
update public.generations set deadline_at = pg_catalog.clock_timestamp() - interval '24 hours' - interval '1 second'
where id = :'boundary_generation'::uuid;
set local role service_role;
select public.complete_comic_save(
  :'boundary_generation'::uuid, :'boundary_owner'::uuid, 1,
  (:'boundary_fixture'::jsonb ->> 'diary_date')::date,
  :'boundary_claim'::uuid, (:'boundary_recovery'::jsonb ->> 'save_claim_token')::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  (:'boundary_recovery'::jsonb -> 'task' -> 'comic_draft'), test.valid_asset_metadata()
) as boundary_completion \gset
select test.assert(:'boundary_completion'::jsonb ->> 'status' = 'failed'
  and (select status = 'failed' from public.generations where id = :'boundary_generation'::uuid)
  and (select state = 'consumed' from private.reservations
    where generation_id = :'boundary_generation'::uuid)
  and not exists (select 1 from public.assets where generation_id = :'boundary_generation'::uuid),
  '24時間を越えた完了はsucceededせずfailed/consumedで確定');

select test.make_saving_fixture('cancelled_upload', true) as cancel_fixture \gset
select (:'cancel_fixture'::jsonb ->> 'generation_id') as cancel_generation \gset
select (:'cancel_fixture'::jsonb ->> 'owner_id') as cancel_owner \gset
select (:'cancel_fixture'::jsonb ->> 'entry_id') as cancel_entry \gset
select (:'cancel_fixture'::jsonb ->> 'claim_token') as cancel_claim \gset
select (:'cancel_fixture'::jsonb ->> 'save_claim_token') as cancel_save_claim \gset
select count || ':' || committed_micro_usd as quota_before_cancel
from private.quota_counters where scope = 'global_total' \gset
select public.request_entry_deletion(:'cancel_owner'::uuid, :'cancel_entry'::uuid);
select public.complete_comic_save(
  :'cancel_generation'::uuid, :'cancel_owner'::uuid, 1,
  (:'cancel_fixture'::jsonb ->> 'diary_date')::date,
  :'cancel_claim'::uuid, :'cancel_save_claim'::uuid,
  'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1',
  (:'cancel_fixture'::jsonb -> 'save' -> 'task' -> 'comic_draft'), test.valid_asset_metadata()
) as cancelled_completion \gset
select test.assert(:'cancelled_completion'::jsonb ->> 'status' = 'cancelled'
  and (select state = 'consumed' from private.reservations
    where generation_id = :'cancel_generation'::uuid)
  and (select count || ':' || committed_micro_usd from private.quota_counters
    where scope = 'global_total') = :'quota_before_cancel'
  and not exists (select 1 from public.assets where generation_id = :'cancel_generation'::uuid),
  'Storage upload中の日記削除はcancelled/consumed確定、残quotaを戻さない');
select test.assert(jsonb_array_length(public.claim_retention_cleanup(10)) = 0,
  '有効なsave leaseが残る間はStorage cleanupをclaimしない');
reset role;
update private.comic_save_tasks set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
where generation_id = :'cancel_generation'::uuid;
set local role service_role;
select public.claim_retention_cleanup(10) as cancel_cleanup \gset
select (:'cancel_cleanup'::jsonb -> 0 ->> 'claim_token') as cancel_cleanup_claim \gset
select test.assert(jsonb_array_length(:'cancel_cleanup'::jsonb) = 1
  and (:'cancel_cleanup'::jsonb -> 0 ->> 'entry_id') = :'cancel_entry'
  and (:'cancel_cleanup'::jsonb -> 0 -> 'object_paths') = (
    select jsonb_agg(asset.value ->> 'object_path' order by asset.value ->> 'object_path')
    from jsonb_array_elements(:'cancel_fixture'::jsonb -> 'save' -> 'task' -> 'asset_metadata')
      with ordinality asset(value, ordinality)
  ), 'cleanup path snapshotは未完了taskの全4画像を列挙');
select public.finalize_retention_cleanup(
    :'cancel_entry'::uuid, :'cancel_cleanup_claim'::uuid, true) as cancel_purged \gset
select test.assert(:'cancel_purged'::boolean
  and not exists (select 1 from public.entries where id = :'cancel_entry'::uuid)
  and not exists (select 1 from public.generations where id = :'cancel_generation'::uuid)
  and not test.comic_save_task_exists(:'cancel_generation'::uuid)
  and test.retained_reservation_state(:'cancel_generation'::uuid) = 'consumed',
  'Storage削除後のpurgeはtask・画像path・jobを掃除し消費台帳を保持');

select test.assert(not has_table_privilege('service_role',
    'private.storage_deletion_outbox', 'SELECT')
  and not has_table_privilege('service_role', 'private.storage_deletion_outbox', 'INSERT')
  and not has_table_privilege('service_role', 'private.storage_deletion_outbox', 'UPDATE')
  and not has_table_privilege('service_role', 'private.storage_deletion_outbox', 'DELETE')
  and not has_table_privilege('anon', 'private.storage_deletion_outbox', 'SELECT')
  and not has_table_privilege('authenticated', 'private.storage_deletion_outbox', 'SELECT')
  and (select relrowsecurity from pg_catalog.pg_class
    where oid = 'private.storage_deletion_outbox'::regclass)
  and not has_function_privilege('anon',
    'public.claim_storage_deletion_cleanup(integer)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.claim_storage_deletion_cleanup(integer)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.finalize_storage_deletion_cleanup(text,uuid,boolean)', 'EXECUTE'),
  '削除outboxはprivateで直接操作不可、GC RPCだけservice_role専用');
select test.expect_error('select * from private.storage_deletion_outbox', '42501');
reset role;
select test.assert((select count(*) = 4
    and bool_and(next_check_at > pg_catalog.clock_timestamp())
    and bool_and(next_check_at <= pg_catalog.clock_timestamp() + interval '61 minutes')
    from private.storage_deletion_outbox
    where object_path in (
      select asset.value ->> 'object_path'
      from jsonb_array_elements(:'cancel_fixture'::jsonb -> 'save' -> 'task' -> 'asset_metadata')
        asset(value)
    )), 'purgeはtaskのplanned path全件を1時間graceつきoutboxへ同時登録');
update private.storage_deletion_outbox
set next_check_at = pg_catalog.clock_timestamp()
where object_path = (:'cancel_fixture'::jsonb -> 'save' -> 'task' ->
  'asset_metadata' -> 0 ->> 'object_path');
set local role service_role;
select public.claim_storage_deletion_cleanup(40) as outbox_claim \gset
select (:'outbox_claim'::jsonb -> 0 ->> 'object_path') as outbox_path \gset
select (:'outbox_claim'::jsonb -> 0 ->> 'claim_token') as outbox_claim_token \gset
reset role;
select test.assert(jsonb_array_length(:'outbox_claim'::jsonb) = 1
  and :'outbox_path' = (:'cancel_fixture'::jsonb -> 'save' -> 'task' ->
    'asset_metadata' -> 0 ->> 'object_path')
  and (:'outbox_claim'::jsonb -> 0 ->> 'lease_expires_at')::timestamptz >
    pg_catalog.clock_timestamp()
  and (:'outbox_claim'::jsonb -> 0 ->> 'lease_expires_at')::timestamptz <=
    pg_catalog.clock_timestamp() + interval '16 minutes'
  and (select next_check_at > pg_catalog.clock_timestamp()
      and next_check_at <= pg_catalog.clock_timestamp() + interval '16 minutes'
    from private.storage_deletion_outbox where object_path = :'outbox_path'),
  'GC claimは期限到来pathだけを15分leaseで取得');
set local role service_role;
select test.assert(not public.finalize_storage_deletion_cleanup(
    :'outbox_path', :'outbox_claim_token'::uuid, false),
  'Storage削除未確認のfinalizeは拒否');
select test.assert(public.finalize_storage_deletion_cleanup(
    :'outbox_path', :'outbox_claim_token'::uuid, true),
  'Storage absence確認後のfinalizeを受理');
select test.assert(not public.finalize_storage_deletion_cleanup(
    :'outbox_path', :'outbox_claim_token'::uuid, true),
  'finalize後の古いclaim token再利用を拒否');
select test.assert(not public.finalize_storage_deletion_cleanup(
    :'outbox_path', null::uuid, true),
  '未claim markerにNULL tokenを指定したfinalizeを拒否');
reset role;
select test.assert((select count(*) = 1 and bool_and(claim_token is null)
    and bool_and(lease_expires_at is null) and bool_and(last_checked_at is not null)
    and bool_and(next_check_at > pg_catalog.clock_timestamp())
    and bool_and(next_check_at <= pg_catalog.clock_timestamp() + interval '25 hours')
    and bool_and(attempt_count = 1)
    from private.storage_deletion_outbox where object_path = :'outbox_path'),
  '確認後もoutbox markerを保持し翌日再照合を予約');
update private.storage_deletion_outbox
set next_check_at = pg_catalog.clock_timestamp()
where object_path = :'outbox_path';
set local role service_role;
select public.claim_storage_deletion_cleanup(40) as outbox_recheck \gset
select (:'outbox_recheck'::jsonb -> 0 ->> 'claim_token') as outbox_recheck_token \gset
select test.assert(jsonb_array_length(:'outbox_recheck'::jsonb) = 1
  and (:'outbox_recheck'::jsonb -> 0 ->> 'object_path') = :'outbox_path'
  and public.finalize_storage_deletion_cleanup(
    :'outbox_path', :'outbox_recheck_token'::uuid, true),
  '日次GCは過去に確認済みの同pathも再照合できる');
reset role;
select test.assert((select count(*) = 1 and bool_and(attempt_count = 2)
    from private.storage_deletion_outbox where object_path = :'outbox_path'),
  '成功済みpath markerは無期限に保持し再確認履歴を増やす');

create temp table outbox_fairness_paths (object_path text primary key) on commit drop;
create temp table outbox_fairness_failed_paths (object_path text primary key) on commit drop;
create temp table outbox_fairness_success_paths (object_path text primary key) on commit drop;
with inserted as (
  insert into private.storage_deletion_outbox (object_path, next_check_at)
  select pg_catalog.format(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/%s/%s.png',
      gen_random_uuid(), gen_random_uuid()),
    pg_catalog.clock_timestamp()
  from pg_catalog.generate_series(1, 45)
  returning object_path
)
insert into outbox_fairness_paths select object_path from inserted;
set local role service_role;
select public.claim_storage_deletion_cleanup(40) as fairness_first_claim \gset
reset role;
insert into outbox_fairness_failed_paths
select candidate.value ->> 'object_path'
from pg_catalog.jsonb_array_elements(:'fairness_first_claim'::jsonb) candidate(value);
select test.assert(jsonb_array_length(:'fairness_first_claim'::jsonb) = 40
    and (select count(*) = 40 from private.storage_deletion_outbox
      where object_path in (select object_path from outbox_fairness_failed_paths)
        and attempt_count = 1
        and next_check_at > pg_catalog.clock_timestamp()),
  'GCは1回あたり40pathをclaimし、失敗pathのretry時刻をlease期限へ進める');
set local role service_role;
select public.claim_storage_deletion_cleanup(40) as fairness_remaining_claim \gset
reset role;
insert into outbox_fairness_success_paths
select candidate.value ->> 'object_path'
from pg_catalog.jsonb_array_elements(:'fairness_remaining_claim'::jsonb) candidate(value);
select test.assert(jsonb_array_length(:'fairness_remaining_claim'::jsonb) = 5
    and (select count(*) = 5 from private.storage_deletion_outbox
      where object_path in (select object_path from outbox_fairness_success_paths)),
  '先頭40pathが失敗しても次のclaimで残り5pathへ進む');
set local role service_role;
select test.assert((
    select pg_catalog.bool_and(public.finalize_storage_deletion_cleanup(
      candidate.value ->> 'object_path',
      (candidate.value ->> 'claim_token')::uuid,
      true))
    from pg_catalog.jsonb_array_elements(:'fairness_remaining_claim'::jsonb) candidate(value)
  ), '成功した残りpathを再確認済みにする');
reset role;
update private.storage_deletion_outbox outbox
set next_check_at = pg_catalog.clock_timestamp(),
    claim_token = null,
    lease_expires_at = null,
    attempt_count = case
      when outbox.object_path in (select object_path from outbox_fairness_failed_paths)
        then 3
      else outbox.attempt_count
    end
where outbox.object_path in (select object_path from outbox_fairness_paths);
set local role service_role;
select public.claim_storage_deletion_cleanup(40) as fairness_recheck_claim \gset
reset role;
select test.assert(jsonb_array_length(:'fairness_recheck_claim'::jsonb) = 40
    and (select count(*) = 5
      from pg_catalog.jsonb_array_elements(:'fairness_recheck_claim'::jsonb) candidate(value)
      where candidate.value ->> 'object_path' in (
        select object_path from outbox_fairness_success_paths)),
  '再確認済みmarkerは繰り返し失敗した未確認markerより先に再確認する');
select test.expect_error(format(
  'insert into private.storage_deletion_outbox(object_path,next_check_at) values (%L,clock_timestamp())',
  'not-a-storage-path'), '23514');

select test.make_saving_fixture('expired_entry', true) as expiry_fixture \gset
select (:'expiry_fixture'::jsonb ->> 'generation_id') as expiry_generation \gset
select (:'expiry_fixture'::jsonb ->> 'owner_id') as expiry_owner \gset
select (:'expiry_fixture'::jsonb ->> 'entry_id') as expiry_entry \gset
select (:'expiry_fixture'::jsonb ->> 'claim_token') as expiry_claim \gset
select (:'expiry_fixture'::jsonb ->> 'save_claim_token') as expiry_save_claim \gset
select count || ':' || committed_micro_usd as quota_before_expiry
from private.quota_counters where scope = 'global_total' \gset
reset role;
update public.entries set expires_at = pg_catalog.clock_timestamp() - interval '1 second'
where id = :'expiry_entry'::uuid;
set local role service_role;
select public.fail_comic_save(:'expiry_generation'::uuid, :'expiry_claim'::uuid,
  :'expiry_save_claim'::uuid) as expiry_result \gset
select test.assert(:'expiry_result'::jsonb ->> 'status' = 'cancelled'
  and (select state = 'consumed' from private.reservations
    where generation_id = :'expiry_generation'::uuid)
  and (select count || ':' || committed_micro_usd from private.quota_counters
    where scope = 'global_total') = :'quota_before_expiry',
  '期限切れentryの保存失敗はcancelled/consumedで予約を返さない');

select test.make_saving_fixture('cancelled_recovery', true) as recovery_cancel_fixture \gset
select (:'recovery_cancel_fixture'::jsonb ->> 'generation_id') as recovery_cancel_generation \gset
select (:'recovery_cancel_fixture'::jsonb ->> 'owner_id') as recovery_cancel_owner \gset
select (:'recovery_cancel_fixture'::jsonb ->> 'entry_id') as recovery_cancel_entry \gset
select (:'recovery_cancel_fixture'::jsonb ->> 'claim_token') as recovery_cancel_claim \gset
reset role;
update public.generations set deadline_at = pg_catalog.clock_timestamp() - interval '1 minute'
where id = :'recovery_cancel_generation'::uuid;
update private.comic_save_tasks set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
where generation_id = :'recovery_cancel_generation'::uuid;
set local role service_role;
select public.request_entry_deletion(:'recovery_cancel_owner'::uuid, :'recovery_cancel_entry'::uuid);
select public.claim_comic_save_recovery(:'recovery_cancel_generation'::uuid) as recovery_cancel_result \gset
select test.assert(:'recovery_cancel_result'::jsonb ->> 'status' = 'cancelled'
  and (select status = 'cancelled' from public.generations
    where id = :'recovery_cancel_generation'::uuid)
  and (select state = 'consumed' from private.reservations
    where generation_id = :'recovery_cancel_generation'::uuid),
  '復旧claim時に削除要求を再検査しcancelled/consumedを確定');

rollback;
