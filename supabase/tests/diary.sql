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
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
delete from auth.users where id = '33333333-3333-4333-8333-333333333333';

set local role service_role;
set local time zone 'Pacific/Honolulu';
select test.assert(
  has_table_privilege('service_role', 'public.entries', 'SELECT')
    and has_table_privilege('service_role', 'public.entries', 'INSERT')
    and has_table_privilege('service_role', 'public.entries', 'UPDATE')
    and not has_table_privilege('service_role', 'public.entries', 'DELETE')
    and not has_table_privilege('service_role', 'public.entries', 'TRUNCATE')
    and not has_table_privilege('service_role', 'public.entries', 'REFERENCES')
    and not has_table_privilege('service_role', 'public.entries', 'TRIGGER')
    and has_table_privilege('service_role', 'public.generations', 'SELECT')
    and has_table_privilege('service_role', 'public.generations', 'INSERT')
    and has_table_privilege('service_role', 'public.generations', 'UPDATE')
    and not has_table_privilege('service_role', 'public.generations', 'DELETE')
    and not has_table_privilege('service_role', 'public.generations', 'TRUNCATE')
    and not has_table_privilege('service_role', 'public.generations', 'REFERENCES')
    and not has_table_privilege('service_role', 'public.generations', 'TRIGGER'),
  'service_roleには必要なDMLだけを付与');
select test.expect_error('delete from public.entries where false', '42501');
do $$
declare
  actor uuid := '11111111-1111-4111-8111-111111111111';
  request uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  today date := (statement_timestamp() at time zone 'Asia/Tokyo')::date;
  first_entry public.entries;
  result public.entries;
begin
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    '33333333-3333-4333-8333-333333333333', gen_random_uuid(), today, '削除済みAuthユーザー', 'v1'),
    'P0001', 'AUTH_REQUIRED');
  first_entry := public.create_entry(actor, request, today, E'\t　架空の日記😀\n', 'v1');
  perform test.assert(first_entry.body = '架空の日記😀' and first_entry.revision = 1, 'Unicode空白をtrimして作成');
  perform test.assert(first_entry.expires_at = first_entry.created_at + interval '30 days', '作成から30日で失効');
  result := public.create_entry(actor, request, today, '架空の日記😀', 'v1');
  perform test.assert(result.id = first_entry.id, '同じ要求の再送で同じ日記を返す');
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, request, today, '別の内容', 'v1'), 'P0001', 'IDEMPOTENCY_CONFLICT');
  result := public.update_entry(actor, first_entry.id, 1, today, '編集した架空の日記');
  perform test.assert(result.revision = 2 and result.body = '編集した架空の日記', '編集でrevisionを増加');
  perform test.assert(result.expires_at = first_entry.expires_at, '編集しても期限を延長しない');
  result := public.create_entry(actor, request, today, '架空の日記😀', 'v1');
  perform test.assert(result.id = first_entry.id and result.revision = 2, '編集後も作成要求を再送できる');
  perform test.expect_error(format('select public.update_entry(%L,%L,1,%L,%L)',
    actor, first_entry.id, today, '古い画面の内容'), 'P0001', 'REVISION_CONFLICT');
  perform test.expect_error(format('select public.update_entry(%L,%L,2,%L,%L)',
    '22222222-2222-4222-8222-222222222222', first_entry.id, today, '他人の編集'), 'P0001', 'NOT_FOUND');
  perform test.expect_error(format('select public.request_entry_deletion(%L,%L)',
    '22222222-2222-4222-8222-222222222222', first_entry.id), 'P0001', 'NOT_FOUND');
  perform test.expect_error(format('select public.update_entry(%L,%L,1,%L,%L)',
    actor, gen_random_uuid(), today, '存在しない日記'), 'P0001', 'NOT_FOUND');
  perform test.expect_error(format('select public.update_entry(%L,%L,2,%L,%L)',
    actor, first_entry.id, today + 1, '未来日の編集'), 'P0001', 'INVALID_INPUT');
  perform test.expect_error(format('select public.update_entry(%L,%L,2,%L,%L)',
    actor, first_entry.id, today, E'\t　\n'), 'P0001', 'INVALID_INPUT');

  foreach request in array array[gen_random_uuid(), gen_random_uuid()] loop
    result := public.create_entry(actor, request, today, repeat('😀',1000), 'v1');
    perform test.assert(char_length(result.body) = 1000, '同日複数記録とUnicode1000文字を許可');
  end loop;
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today, repeat('😀',1001), 'v1'), 'P0001', 'INVALID_INPUT');
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today, E'\t　\n', 'v1'), 'P0001', 'INVALID_INPUT');
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today + 1, '未来日', 'v1'), 'P0001', 'INVALID_INPUT');
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), 'infinity', '無限の日付', 'v1'), 'P0001', 'INVALID_INPUT');
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today, null, 'v1'), 'P0001', 'INVALID_INPUT');
  perform test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
    actor, gen_random_uuid(), today, '同意なし', null), 'P0001', 'CONSENT_REQUIRED');
  perform test.expect_error(format('select public.create_entry(null,%L,%L,%L,%L)',
    gen_random_uuid(), today, '認証なし', 'v1'), 'P0001', 'AUTH_REQUIRED');
end;
$$;

select id as entry_id from public.entries
  where create_request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' \gset
insert into public.generations (
  id, entry_id, owner_id, entry_revision, idempotency_key, request_hash, input_snapshot, model_profile_snapshot
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', :'entry_id',
  '11111111-1111-4111-8111-111111111111', 2, gen_random_uuid(), 'fixture', '架空の脚本用入力', '{}'
);
update public.entries set latest_generation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' where id = :'entry_id';
select test.expect_error(format('select public.update_entry(%L,%L,2,current_date,%L)',
  '11111111-1111-4111-8111-111111111111', :'entry_id', '生成中の編集'), 'P0001', 'ENTRY_BUSY');
update public.generations set status = 'running', stage = 'script';
select test.expect_error(format('select public.update_entry(%L,%L,2,current_date,%L)',
  '11111111-1111-4111-8111-111111111111', :'entry_id', '生成中の編集'), 'P0001', 'ENTRY_BUSY');
select test.expect_error(format($cmd$insert into public.generations (
  entry_id, owner_id, entry_revision, idempotency_key, request_hash, input_snapshot, model_profile_snapshot, status
) values (%L,%L,1,gen_random_uuid(),'fixture','架空','{}','failed')$cmd$,
  :'entry_id', '22222222-2222-4222-8222-222222222222'), '23503');
select test.expect_error(format($cmd$insert into public.generations (
  entry_id, owner_id, entry_revision, idempotency_key, request_hash, input_snapshot, model_profile_snapshot
) values (%L,%L,2,gen_random_uuid(),'fixture','架空','{}')$cmd$,
  :'entry_id', '11111111-1111-4111-8111-111111111111'), '23505');

select (public.create_entry('22222222-2222-4222-8222-222222222222', gen_random_uuid(), current_date, '他人の架空日記', 'v1')).id as other_entry_id \gset
select test.expect_error(format('update public.entries set latest_generation_id = %L where id = %L',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', :'other_entry_id'), '23503');
insert into public.generations (
  id, entry_id, owner_id, entry_revision, idempotency_key, request_hash,
  input_snapshot, model_profile_snapshot, status
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', :'other_entry_id',
  '22222222-2222-4222-8222-222222222222', 1, gen_random_uuid(),
  'fixture', '他人の架空日記', '{}', 'failed'
);
update public.entries set latest_generation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  where id = :'other_entry_id';
select test.assert((public.update_entry('22222222-2222-4222-8222-222222222222',
  :'other_entry_id', 1, current_date, '生成終了後の編集')).revision = 2, 'activeでなければ編集できる');
select test.assert((select latest_generation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  from public.entries where id = :'other_entry_id'), '編集しても既存ジョブへの参照を保持');
select test.assert((select entry_revision = 1 and input_snapshot = '他人の架空日記'
  from public.generations where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'), '編集前のrevisionと入力を保持');

set local role anon;
select test.expect_error('select id from public.entries', '42501');
select test.expect_error('select id from public.generations', '42501');
select test.expect_error('select public.create_entry(null,null,null,null,null)', '42501');
select test.expect_error('select public.update_entry(null,null,null,null,null)', '42501');
select test.expect_error('select public.request_entry_deletion(null,null)', '42501');

set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select test.assert((select count(id) = 1 from public.entries), 'ユーザーBは自分の日記だけ読める');
select test.assert((select count(id) = 1 from public.generations), 'ユーザーBは自分のジョブだけ読める');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select test.assert((select count(id) = 3 from public.entries), 'ユーザーAは自分の日記だけ読める');
select test.assert((select count(id) = 1 from public.generations), '本人はジョブを読める');
select test.expect_error('select input_snapshot from public.generations', '42501');
select test.expect_error('select claim_token from public.generations', '42501');
select test.expect_error('select create_request_hash from public.entries', '42501');
select test.expect_error('select public.create_entry(null,null,null,null,null)', '42501');
select test.expect_error('select public.update_entry(null,null,null,null,null)', '42501');
select test.expect_error('select public.request_entry_deletion(null,null)', '42501');
select test.expect_error('insert into public.entries default values', '42501');
select test.expect_error('update public.entries set body = ''改変''', '42501');
select test.expect_error('delete from public.entries', '42501');
select test.expect_error('insert into public.generations default values', '42501');
select test.expect_error('update public.generations set status = ''cancelled''', '42501');
select test.expect_error('delete from public.generations', '42501');
select test.expect_error('select private.trim_diary_body(''架空'')', '42501');
select set_config('request.jwt.claim.sub', '', true);
select test.assert((select count(id) = 0 from public.entries), 'subなしでは読めない');

set local role service_role;
select test.assert(public.request_entry_deletion('11111111-1111-4111-8111-111111111111', :'entry_id')
  = '{"deletionAccepted":true}'::jsonb, '削除受付レスポンス');
select test.assert((select cancel_requested from public.generations
  where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), '進行中ジョブにキャンセル要求を付ける');
select test.expect_error(format('select public.update_entry(%L,%L,2,current_date,%L)',
  '11111111-1111-4111-8111-111111111111', :'entry_id', '削除済みの編集'), 'P0001', 'NOT_FOUND');
select test.expect_error(format('select public.create_entry(%L,%L,%L,%L,%L)',
  '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (statement_timestamp() at time zone 'Asia/Tokyo')::date, '架空の日記😀', 'v1'), 'P0001', 'NOT_FOUND');
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select test.assert((select count(id) = 0 from public.entries where id = :'entry_id'), '削除後は日記を即座に非表示');
select test.assert((select count(id) = 0 from public.generations), '削除後はジョブも非表示');

set local role service_role;
update public.entries set expires_at = now() - interval '1 second' where deleted_at is null;
select test.expect_error(format('select public.update_entry(%L,%L,1,current_date,%L)',
  '22222222-2222-4222-8222-222222222222', :'other_entry_id', '期限後の編集'), 'P0001', 'NOT_FOUND');
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select test.assert((select count(id) = 0 from public.entries), '期限切れを非表示');
select test.assert((select count(id) = 0 from public.generations), '期限切れのジョブも非表示');

set local role service_role;
do $$
declare actor uuid := '22222222-2222-4222-8222-222222222222'; result public.entries;
begin
  for i in 1..20 loop
    result := public.create_entry(actor, gen_random_uuid(), current_date, '上限確認の架空日記', 'v1');
  end loop;
  perform test.assert((public.create_entry(actor, result.create_request_id, current_date,
    '上限確認の架空日記', 'v1')).id = result.id, '上限到達後も既存作成要求は再送できる');
  perform test.expect_error(format('select public.create_entry(%L,%L,current_date,%L,%L)',
    actor, gen_random_uuid(), '21件目', 'v1'), 'P0001', 'DRAFT_LIMIT_REACHED');
  perform public.request_entry_deletion(actor, result.id);
  perform public.create_entry(actor, gen_random_uuid(), current_date, '削除後の空き枠', 'v1');
end;
$$;
rollback;
