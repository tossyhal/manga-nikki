begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

-- JavaScriptのString.trim()と同じ空白を除去する。
create function private.trim_diary_body(value text)
returns text language sql immutable strict security invoker set search_path = ''
as $$
  select pg_catalog.btrim(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;
revoke all on function private.trim_diary_body(text) from public, anon, authenticated;
grant execute on function private.trim_diary_body(text) to service_role;

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  create_request_id uuid not null,
  -- 編集後の再送でも、作成時と同じ要求かを判定する。
  create_request_hash bytea not null check (octet_length(create_request_hash) = 32),
  diary_date date not null check (diary_date between date '0001-01-01' and date '9999-12-31'),
  body text not null check (
    char_length(body) between 1 and 1000 and body = private.trim_diary_body(body)
  ),
  revision integer not null default 1 check (revision > 0),
  latest_generation_id uuid,
  consent_version text not null check (consent_version = 'v1'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (owner_id, create_request_id),
  unique (id, owner_id)
);
create index entries_owner_date_id on public.entries (owner_id, diary_date desc, id desc);

create table public.generations (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  owner_id uuid not null,
  entry_revision integer not null check (entry_revision > 0),
  idempotency_key uuid not null,
  request_hash text not null,
  input_snapshot text not null check (char_length(input_snapshot) between 1 and 1000),
  model_profile_snapshot jsonb not null check (jsonb_typeof(model_profile_snapshot) = 'object'),
  claim_token uuid,
  deadline_at timestamptz,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled')),
  stage text check (stage in ('script', 'images', 'saving')),
  comic_json jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  enqueued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancel_requested boolean not null default false,
  foreign key (entry_id, owner_id) references public.entries(id, owner_id),
  unique (owner_id, idempotency_key),
  unique (id, entry_id, owner_id),
  check ((status = 'running' and stage is not null) or (status <> 'running' and stage is null))
);
create index generations_owner_created on public.generations (owner_id, created_at desc);
create index generations_status_created on public.generations (status, created_at);
create index generations_entry on public.generations (entry_id, owner_id);
create unique index generations_one_active_per_entry on public.generations (entry_id)
  where status in ('queued', 'running');

alter table public.entries add constraint entries_latest_generation_fk
  foreign key (latest_generation_id, id, owner_id)
  references public.generations(id, entry_id, owner_id);

alter table public.entries enable row level security;
alter table public.generations enable row level security;
revoke all on public.entries, public.generations from public, anon, authenticated;
grant select (
  id, owner_id, create_request_id, diary_date, body, revision, latest_generation_id,
  consent_version, created_at, updated_at, deleted_at, expires_at
) on public.entries to authenticated;
grant select (
  id, entry_id, owner_id, entry_revision, status, stage, comic_json, error_code,
  created_at, updated_at, completed_at, cancel_requested
) on public.generations to authenticated;
grant select, insert, update, delete on public.entries, public.generations to service_role;

create policy entries_read_own on public.entries for select to authenticated
  using (owner_id = (select auth.uid()) and deleted_at is null and expires_at > now());
create policy generations_read_own on public.generations for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.entries e
    where e.id = entry_id and e.owner_id = generations.owner_id
      and e.deleted_at is null and e.expires_at > now()
  ));

create function public.create_entry(
  p_actor_id uuid, p_create_request_id uuid, p_diary_date date,
  p_body text, p_consent_version text
)
returns public.entries language plpgsql security invoker set search_path = ''
as $$
declare
  v_body text := private.trim_diary_body(p_body);
  v_hash bytea;
  v_entry public.entries;
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;
  if p_create_request_id is null or p_diary_date is null or not isfinite(p_diary_date)
    or p_diary_date < date '0001-01-01'
    or p_diary_date > (statement_timestamp() at time zone 'Asia/Tokyo')::date
    or v_body is null or char_length(v_body) not between 1 and 1000 then
    raise exception using message = 'INVALID_INPUT';
  end if;
  if p_consent_version is distinct from 'v1' then
    raise exception using message = 'CONSENT_REQUIRED';
  end if;
  v_hash := sha256(convert_to(jsonb_build_array(p_diary_date, v_body, p_consent_version)::text, 'UTF8'));
  -- 同一所有者の作成を直列化し、最後の下書き枠と冪等性を同時に守る。
  perform pg_advisory_xact_lock(hashtextextended(p_actor_id::text, 0));
  select * into v_entry from public.entries
    where owner_id = p_actor_id and create_request_id = p_create_request_id for update;
  if found then
    if v_entry.deleted_at is not null or v_entry.expires_at <= statement_timestamp() then
      raise exception using message = 'NOT_FOUND';
    end if;
    if v_entry.create_request_hash <> v_hash then
      raise exception using message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_entry;
  end if;
  if (select count(*) from public.entries
    where owner_id = p_actor_id and deleted_at is null and expires_at > statement_timestamp()
      and latest_generation_id is null) >= 20 then
    raise exception using message = 'DRAFT_LIMIT_REACHED';
  end if;
  insert into public.entries (
    owner_id, create_request_id, create_request_hash, diary_date, body, consent_version
  ) values (p_actor_id, p_create_request_id, v_hash, p_diary_date, v_body, p_consent_version)
  returning * into v_entry;
  return v_entry;
end;
$$;

create function public.update_entry(
  p_actor_id uuid, p_entry_id uuid, p_expected_revision integer, p_diary_date date, p_body text
)
returns public.entries language plpgsql security invoker set search_path = ''
as $$
declare
  v_entry public.entries;
  v_body text := private.trim_diary_body(p_body);
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;
  select * into v_entry from public.entries
    where id = p_entry_id and owner_id = p_actor_id for update;
  if not found or v_entry.deleted_at is not null or v_entry.expires_at <= statement_timestamp() then
    raise exception using message = 'NOT_FOUND';
  end if;
  if p_expected_revision is distinct from v_entry.revision then
    raise exception using message = 'REVISION_CONFLICT';
  end if;
  if exists (select 1 from public.generations
    where entry_id = p_entry_id and owner_id = p_actor_id and status in ('queued', 'running')) then
    raise exception using message = 'ENTRY_BUSY';
  end if;
  if p_diary_date is null or not isfinite(p_diary_date) or p_diary_date < date '0001-01-01'
    or p_diary_date > (statement_timestamp() at time zone 'Asia/Tokyo')::date
    or v_body is null or char_length(v_body) not between 1 and 1000 then
    raise exception using message = 'INVALID_INPUT';
  end if;
  update public.entries set diary_date = p_diary_date, body = v_body,
    revision = revision + 1, updated_at = statement_timestamp()
    where id = p_entry_id returning * into v_entry;
  return v_entry;
end;
$$;

create function public.request_entry_deletion(p_actor_id uuid, p_entry_id uuid)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare v_entry public.entries;
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;
  select * into v_entry from public.entries
    where id = p_entry_id and owner_id = p_actor_id for update;
  if not found or v_entry.deleted_at is not null or v_entry.expires_at <= statement_timestamp() then
    raise exception using message = 'NOT_FOUND';
  end if;
  update public.entries set deleted_at = statement_timestamp(), updated_at = statement_timestamp()
    where id = p_entry_id;
  update public.generations set cancel_requested = true, updated_at = statement_timestamp()
    where entry_id = p_entry_id and owner_id = p_actor_id and status in ('queued', 'running');
  return jsonb_build_object('deletionAccepted', true);
end;
$$;

revoke all on function public.create_entry(uuid, uuid, date, text, text) from public, anon, authenticated;
revoke all on function public.update_entry(uuid, uuid, integer, date, text) from public, anon, authenticated;
revoke all on function public.request_entry_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_entry(uuid, uuid, date, text, text) to service_role;
grant execute on function public.update_entry(uuid, uuid, integer, date, text) to service_role;
grant execute on function public.request_entry_deletion(uuid, uuid) to service_role;

commit;
