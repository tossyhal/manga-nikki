\set ON_ERROR_STOP on
begin;
do $$
declare
  actor uuid := pg_catalog.gen_random_uuid();
  entry_id uuid;
  generation_id uuid := pg_catalog.gen_random_uuid();
  token text := pg_catalog.repeat('a', 64);
  result jsonb;
begin
  insert into auth.users(id) values(actor);
  insert into public.entries(owner_id, create_request_id, create_request_hash, diary_date, body, consent_version)
    values(actor, pg_catalog.gen_random_uuid(), decode(pg_catalog.repeat('00', 32), 'hex'), current_date, '非公開の本文', 'v1') returning id into entry_id;
  insert into public.generations(id, entry_id, owner_id, entry_revision, idempotency_key, request_hash, input_snapshot, model_profile_snapshot, status, comic_json, is_mock)
    values(generation_id, entry_id, actor, 1, pg_catalog.gen_random_uuid(), 'share-test', '非公開の本文', '{}'::jsonb, 'succeeded', '{"title":"共有される漫画"}', true);
  if public.read_comic_share(token) is not null then raise exception '未共有の漫画を公開した'; end if;
  begin
    perform public.create_comic_share(pg_catalog.gen_random_uuid(), generation_id, token);
    raise exception '他人の漫画を共有できた';
  exception when raise_exception then
    if sqlerrm <> 'NOT_FOUND' then raise; end if;
  end;
  if public.create_comic_share(actor, generation_id, token) <> token then raise exception 'token不一致'; end if;
  if public.create_comic_share(actor, generation_id, pg_catalog.repeat('b',64)) <> token then raise exception '再送でtokenが変わった'; end if;
  result := public.read_comic_share(token);
  if result -> 'comic' ->> 'title' <> '共有される漫画' or result::text like '%非公開の本文%' then raise exception '公開データが不正'; end if;
  update public.entries set expires_at = pg_catalog.clock_timestamp() - interval '1 second' where id = entry_id;
  if public.read_comic_share(token) is not null then raise exception '期限後も共有できた'; end if;
  update public.entries set expires_at = pg_catalog.clock_timestamp() + interval '1 day', deleted_at = pg_catalog.clock_timestamp() where id = entry_id;
  if public.read_comic_share(token) is not null then raise exception '削除後も共有できた'; end if;
  if has_function_privilege('anon', 'public.create_comic_share(uuid,uuid,text)', 'EXECUTE') or
     has_function_privilege('authenticated', 'public.read_comic_share(text)', 'EXECUTE') or
     not has_function_privilege('service_role', 'public.create_comic_share(uuid,uuid,text)', 'EXECUTE') or
     not has_function_privilege('service_role', 'public.read_comic_share(text)', 'EXECUTE') or
     has_function_privilege('anon', 'public.read_comic_share(text)', 'EXECUTE') or
     has_function_privilege('authenticated', 'public.create_comic_share(uuid,uuid,text)', 'EXECUTE') or
     has_table_privilege('service_role', 'private.comic_shares', 'SELECT') then raise exception '共有権限が過剰'; end if;
end;
$$;
rollback;
