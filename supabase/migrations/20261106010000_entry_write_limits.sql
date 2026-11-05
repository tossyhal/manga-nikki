begin;

create table private.entry_creation_global_daily (
  day_key date primary key,
  creation_count integer not null check (creation_count between 0 and 1000)
);
alter table private.entry_creation_global_daily enable row level security;
revoke all on private.entry_creation_global_daily from public, anon, authenticated, service_role;

create table private.entry_creation_owner_daily (
  owner_id uuid not null,
  day_key date not null,
  creation_count integer not null check (creation_count between 0 and 50),
  primary key (owner_id, day_key)
);
create index entry_creation_owner_daily_day on private.entry_creation_owner_daily (day_key);
alter table private.entry_creation_owner_daily enable row level security;
revoke all on private.entry_creation_owner_daily from public, anon, authenticated, service_role;

create or replace function public.create_entry(
  p_actor_id uuid, p_create_request_id uuid, p_diary_date date,
  p_body text, p_consent_version text
)
returns public.entries language plpgsql security definer set search_path = ''
as $$
declare
  v_body text := private.trim_diary_body(p_body);
  v_hash bytea;
  v_constraint text;
  v_entry public.entries;
  v_now timestamptz;
  v_day date;
  v_owner_daily_count integer;
  v_global_daily_count integer;
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;
  if p_create_request_id is null or p_diary_date is null or not pg_catalog.isfinite(p_diary_date)
    or p_diary_date < date '0001-01-01'
    or v_body is null or char_length(v_body) not between 1 and 1000 then
    raise exception using message = 'INVALID_INPUT';
  end if;
  if p_consent_version is distinct from 'v1' then
    raise exception using message = 'CONSENT_REQUIRED';
  end if;
  v_hash := pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(p_diary_date, v_body, p_consent_version)::text, 'UTF8'));

  -- 生成予約・物理purgeと共通のglobal lockを先に取り、owner lockへ進む順序を保つ。
  perform pg_catalog.pg_advisory_xact_lock(20261103, 10001);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_id::text, 0));
  v_now := pg_catalog.clock_timestamp();
  if p_diary_date > (v_now at time zone 'Asia/Tokyo')::date then
    raise exception using message = 'INVALID_INPUT';
  end if;
  v_day := (v_now at time zone 'Asia/Tokyo')::date;

  if exists (select 1 from private.entry_tombstones t
    where t.owner_id = p_actor_id and t.create_request_id = p_create_request_id) then
    raise exception using message = 'NOT_FOUND';
  end if;
  select * into v_entry from public.entries
    where owner_id = p_actor_id and create_request_id = p_create_request_id for update;
  if found then
    if v_entry.deleted_at is not null or v_entry.expires_at <= v_now then
      raise exception using message = 'NOT_FOUND';
    end if;
    if v_entry.create_request_hash <> v_hash then
      raise exception using message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_entry;
  end if;

  if (select count(*) from public.entries
    where owner_id = p_actor_id and deleted_at is null
      and expires_at > v_now and latest_generation_id is null) >= 20 then
    raise exception using message = 'DRAFT_LIMIT_REACHED';
  end if;

  -- 論理削除・期限切れの行も、Storage-first purgeが完了するまでは保持上限に数える。
  if (select count(*) from public.entries where owner_id = p_actor_id) >= 100 then
    raise exception using message = 'ENTRY_OWNER_RETAINED_LIMIT_REACHED';
  end if;
  if (select count(*) from public.entries) >= 5000 then
    raise exception using message = 'ENTRY_GLOBAL_RETAINED_LIMIT_REACHED';
  end if;

  delete from private.entry_creation_owner_daily where day_key < v_day;
  delete from private.entry_creation_global_daily where day_key < v_day;

  select c.creation_count into v_owner_daily_count
    from private.entry_creation_owner_daily c
    where c.owner_id = p_actor_id and c.day_key = v_day;
  if coalesce(v_owner_daily_count, 0) >= 50 then
    raise exception using message = 'ENTRY_OWNER_CREATE_LIMIT_REACHED';
  end if;
  select c.creation_count into v_global_daily_count
    from private.entry_creation_global_daily c where c.day_key = v_day;
  if coalesce(v_global_daily_count, 0) >= 1000 then
    raise exception using message = 'ENTRY_GLOBAL_CREATE_LIMIT_REACHED';
  end if;

  insert into private.entry_creation_owner_daily (owner_id, day_key, creation_count)
    values (p_actor_id, v_day, 1)
    on conflict (owner_id, day_key) do update
      set creation_count = private.entry_creation_owner_daily.creation_count + 1;
  insert into private.entry_creation_global_daily (day_key, creation_count)
    values (v_day, 1)
    on conflict (day_key) do update
      set creation_count = private.entry_creation_global_daily.creation_count + 1;

  begin
    insert into public.entries (
      owner_id, create_request_id, create_request_hash, diary_date, body, consent_version
    ) values (p_actor_id, p_create_request_id, v_hash, p_diary_date, v_body, p_consent_version)
    returning * into v_entry;
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'entries_owner_id_fkey' then
      raise exception using message = 'AUTH_REQUIRED';
    end if;
    raise;
  end;
  return v_entry;
end;
$$;

revoke all on function public.create_entry(uuid, uuid, date, text, text)
  from public, anon, authenticated;
grant execute on function public.create_entry(uuid, uuid, date, text, text) to service_role;

commit;
