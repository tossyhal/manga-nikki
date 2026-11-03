-- Supabase Storage API有効環境でのみ適用する。Storage schemaを含まない隔離DB用ではない。
begin;

do $$
begin
  if pg_catalog.to_regclass('storage.buckets') is null
    or pg_catalog.to_regclass('storage.objects') is null then
    raise exception using message = 'STORAGE_PLATFORM_SCHEMA_REQUIRED';
  end if;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comics', 'comics', false, 8388608, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table storage.objects enable row level security;
drop policy if exists comics_deny_direct_user_access on storage.objects;
create policy comics_deny_direct_user_access on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'comics')
  with check (bucket_id <> 'comics');

commit;
