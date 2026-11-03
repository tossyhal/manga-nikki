begin;

create table public.assets (
  id uuid primary key,
  generation_id uuid not null,
  owner_id uuid not null,
  object_path text not null unique,
  media_type text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 8388608),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  foreign key (generation_id, owner_id)
    references public.generations(id, owner_id),
  check (object_path = owner_id::text || '/' || generation_id::text || '/' || id::text ||
    case media_type
      when 'image/png' then '.png'
      when 'image/jpeg' then '.jpg'
      when 'image/webp' then '.webp'
    end)
);
create index assets_generation_owner on public.assets (generation_id, owner_id);
alter table public.assets enable row level security;
revoke all on public.assets from public, anon, authenticated, service_role;
grant select (id, generation_id) on public.assets to authenticated;
grant select, insert on public.assets to service_role;
create policy assets_read_own_live_entry on public.assets for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1
    from public.generations g
    join public.entries e on e.id = g.entry_id and e.owner_id = g.owner_id
    where g.id = assets.generation_id and g.owner_id = assets.owner_id
      and e.deleted_at is null and e.expires_at > pg_catalog.statement_timestamp()
  ));

create table private.entry_tombstones (
  owner_id uuid not null,
  create_request_id uuid not null,
  entry_id uuid not null,
  purged_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (owner_id, create_request_id)
);
alter table private.entry_tombstones enable row level security;
revoke all on private.entry_tombstones from public, anon, authenticated, service_role;
grant select on private.entry_tombstones to service_role;

create table private.retention_cleanup_leases (
  entry_id uuid primary key,
  owner_id uuid not null,
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  object_paths text[] not null default '{}'::text[],
  foreign key (entry_id, owner_id) references public.entries(id, owner_id)
);
alter table private.retention_cleanup_leases enable row level security;
revoke all on private.retention_cleanup_leases from public, anon, authenticated, service_role;

create table private.retained_generation_ledger (
  generation_id uuid primary key,
  owner_id uuid not null,
  generation_status text not null
    check (generation_status in ('queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled')),
  reservation_present boolean not null,
  reserved_day date,
  max_cost_micro_usd bigint,
  reservation_state text check (reservation_state in ('reserved', 'consumed', 'held', 'released')),
  archived_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (
    (reservation_present and reserved_day is not null and max_cost_micro_usd is not null
      and max_cost_micro_usd >= 0
      and reservation_state is not null)
    or (not reservation_present and reserved_day is null and max_cost_micro_usd is null
      and reservation_state is null)
  )
);
alter table private.retained_generation_ledger enable row level security;
revoke all on private.retained_generation_ledger from public, anon, authenticated, service_role;

create table private.retained_generation_requests (
  owner_id uuid not null,
  idempotency_key uuid not null,
  request_hash text not null,
  primary key (owner_id, idempotency_key)
);
alter table private.retained_generation_requests enable row level security;
revoke all on private.retained_generation_requests from public, anon, authenticated, service_role;
grant select on private.retained_generation_requests to service_role;

alter function public.reserve_generation(uuid, uuid, integer, uuid, boolean)
  set schema private;
alter function private.reserve_generation(uuid, uuid, integer, uuid, boolean)
  rename to reserve_generation_existing_key;

create or replace function public.find_generation_receipt(
  p_actor_id uuid,
  p_entry_id uuid,
  p_expected_revision integer,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_entry public.entries;
  v_generation public.generations;
  v_request_hash text;
  v_archived_request_hash text;
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;
  if p_entry_id is null or p_expected_revision is null or p_expected_revision <= 0
    or p_idempotency_key is null then
    raise exception using message = 'INVALID_INPUT';
  end if;

  select * into v_entry from public.entries e
    where e.id = p_entry_id and e.owner_id = p_actor_id;
  if not found or not private.is_live_generation_entry(v_entry) then
    raise exception using message = 'NOT_FOUND';
  end if;

  v_request_hash := private.generation_request_hash(p_entry_id, p_expected_revision);
  select a.request_hash into v_archived_request_hash
    from private.retained_generation_requests a
    where a.owner_id = p_actor_id and a.idempotency_key = p_idempotency_key;
  if found then
    if v_archived_request_hash is distinct from v_request_hash then
      raise exception using message = 'IDEMPOTENCY_CONFLICT';
    end if;
    raise exception using message = 'NOT_FOUND';
  end if;

  select * into v_generation from public.generations g
    where g.owner_id = p_actor_id and g.idempotency_key = p_idempotency_key;
  if not found then return null; end if;
  if v_generation.request_hash is distinct from v_request_hash then
    raise exception using message = 'IDEMPOTENCY_CONFLICT';
  end if;

  return pg_catalog.jsonb_build_object(
    'generation_id', v_generation.id,
    'status', v_generation.status,
    'status_url', '/api/v1/generations/' || v_generation.id::text
  );
end;
$$;

create function public.reserve_generation(
  p_actor_id uuid,
  p_entry_id uuid,
  p_expected_revision integer,
  p_idempotency_key uuid,
  p_generation_enabled boolean
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_receipt jsonb;
begin
  v_receipt := public.find_generation_receipt(
    p_actor_id, p_entry_id, p_expected_revision, p_idempotency_key
  );
  if v_receipt is not null then return v_receipt; end if;

  perform pg_catalog.pg_advisory_xact_lock(20261103, 10001);
  v_receipt := public.find_generation_receipt(
    p_actor_id, p_entry_id, p_expected_revision, p_idempotency_key
  );
  if v_receipt is not null then return v_receipt; end if;

  return private.reserve_generation_existing_key(
    p_actor_id, p_entry_id, p_expected_revision, p_idempotency_key, p_generation_enabled
  );
end;
$$;
revoke all on function public.find_generation_receipt(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.reserve_generation(uuid, uuid, integer, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.find_generation_receipt(uuid, uuid, integer, uuid)
  to service_role;
grant execute on function public.reserve_generation(uuid, uuid, integer, uuid, boolean)
  to service_role;

create table private.retained_provider_attempts (
  attempt_id uuid primary key,
  generation_id uuid not null,
  owner_id uuid not null,
  stage text not null check (stage in ('script', 'images')),
  call_index integer not null check (call_index >= 0),
  is_mock boolean not null,
  state text not null check (state in ('dispatched', 'succeeded', 'failed', 'unknown')),
  request_id text check (request_id is null or char_length(request_id) <= 200),
  started_at timestamptz not null,
  finished_at timestamptz,
  archived_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table private.retained_provider_attempts enable row level security;
revoke all on private.retained_provider_attempts from public, anon, authenticated, service_role;

create or replace function public.create_entry(
  p_actor_id uuid, p_create_request_id uuid, p_diary_date date,
  p_body text, p_consent_version text
)
returns public.entries language plpgsql security invoker set search_path = ''
as $$
declare
  v_body text := private.trim_diary_body(p_body);
  v_hash bytea;
  v_constraint text;
  v_entry public.entries;
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;
  if p_create_request_id is null or p_diary_date is null or not isfinite(p_diary_date)
    or p_diary_date < date '0001-01-01'
    or p_diary_date > (pg_catalog.statement_timestamp() at time zone 'Asia/Tokyo')::date
    or v_body is null or char_length(v_body) not between 1 and 1000 then
    raise exception using message = 'INVALID_INPUT';
  end if;
  if p_consent_version is distinct from 'v1' then
    raise exception using message = 'CONSENT_REQUIRED';
  end if;
  v_hash := pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(p_diary_date, v_body, p_consent_version)::text, 'UTF8'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_id::text, 0));
  if exists (select 1 from private.entry_tombstones t
    where t.owner_id = p_actor_id and t.create_request_id = p_create_request_id) then
    raise exception using message = 'NOT_FOUND';
  end if;
  select * into v_entry from public.entries
    where owner_id = p_actor_id and create_request_id = p_create_request_id for update;
  if found then
    if v_entry.deleted_at is not null or v_entry.expires_at <= pg_catalog.statement_timestamp() then
      raise exception using message = 'NOT_FOUND';
    end if;
    if v_entry.create_request_hash <> v_hash then
      raise exception using message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_entry;
  end if;
  if (select count(*) from public.entries
    where owner_id = p_actor_id and deleted_at is null
      and expires_at > pg_catalog.statement_timestamp() and latest_generation_id is null) >= 20 then
    raise exception using message = 'DRAFT_LIMIT_REACHED';
  end if;
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
revoke all on function public.create_entry(uuid, uuid, date, text, text) from public, anon, authenticated;
grant execute on function public.create_entry(uuid, uuid, date, text, text) to service_role;

create function public.claim_retention_cleanup(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_claims jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception using message = 'INVALID_INPUT';
  end if;

  with candidates as materialized (
    select e.id, e.owner_id, pg_catalog.gen_random_uuid() as claim_token
    from public.entries e
    where (e.deleted_at is not null or e.expires_at <= v_now)
      and not exists (
        select 1 from public.generations g
        where g.entry_id = e.id and g.owner_id = e.owner_id
          and g.status in ('queued', 'running')
      )
      and not exists (
        select 1 from private.retention_cleanup_leases l
        where l.entry_id = e.id and l.lease_expires_at > v_now
      )
    order by coalesce(e.deleted_at, e.expires_at), e.id
    limit p_limit
    for update of e skip locked
  ), claimed as (
    insert into private.retention_cleanup_leases (
      entry_id, owner_id, claim_token, lease_expires_at, object_paths
    )
    select c.id, c.owner_id, c.claim_token, v_now + interval '15 minutes',
      coalesce((
        select pg_catalog.array_agg(a.object_path order by a.object_path)
        from public.assets a
        join public.generations g on g.id = a.generation_id and g.owner_id = a.owner_id
        where g.entry_id = c.id and g.owner_id = c.owner_id
      ), '{}'::text[])
    from candidates c
    on conflict (entry_id) do update set
      owner_id = excluded.owner_id,
      claim_token = excluded.claim_token,
      lease_expires_at = excluded.lease_expires_at,
      object_paths = excluded.object_paths
    where private.retention_cleanup_leases.lease_expires_at <= v_now
    returning entry_id, owner_id, claim_token, lease_expires_at, object_paths
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'entry_id', c.entry_id,
      'owner_id', c.owner_id,
      'claim_token', c.claim_token,
      'lease_expires_at', c.lease_expires_at,
      'object_paths', c.object_paths
    ) order by c.entry_id), '[]'::jsonb)
  into v_claims
  from claimed c;

  return v_claims;
end;
$$;

create function public.finalize_retention_cleanup(
  p_entry_id uuid, p_claim_token uuid, p_storage_deleted boolean
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_entry public.entries;
  v_generation public.generations;
  v_lease private.retention_cleanup_leases;
  v_object_paths text[];
  v_now timestamptz;
begin
  if p_entry_id is null or p_claim_token is null or p_storage_deleted is distinct from true then
    return false;
  end if;

  select l.owner_id into v_owner_id from private.retention_cleanup_leases l
    where l.entry_id = p_entry_id;
  if not found then
    return exists (select 1 from private.entry_tombstones t where t.entry_id = p_entry_id);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(20261103, 10001);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner_id::text, 0));

  select * into v_entry from public.entries e where e.id = p_entry_id for update;
  if not found then
    return exists (select 1 from private.entry_tombstones t where t.entry_id = p_entry_id);
  end if;
  if v_entry.owner_id <> v_owner_id then return false; end if;

  select * into v_lease from private.retention_cleanup_leases l
    where l.entry_id = p_entry_id for update;
  if not found or v_lease.owner_id <> v_owner_id or v_lease.claim_token <> p_claim_token then
    return false;
  end if;
  v_now := pg_catalog.clock_timestamp();
  if v_lease.lease_expires_at <= v_now
    or (v_entry.deleted_at is null and v_entry.expires_at > v_now) then
    return false;
  end if;

  for v_generation in
    select g.* from public.generations g
    where g.entry_id = p_entry_id and g.owner_id = v_owner_id
    order by g.id for update
  loop
    if v_generation.status in ('queued', 'running') then return false; end if;
  end loop;

  select coalesce(pg_catalog.array_agg(a.object_path order by a.object_path), '{}'::text[])
    into v_object_paths
  from public.assets a
  join public.generations g on g.id = a.generation_id and g.owner_id = a.owner_id
  where g.entry_id = p_entry_id and g.owner_id = v_owner_id;
  if v_object_paths is distinct from v_lease.object_paths then return false; end if;

  insert into private.entry_tombstones (owner_id, create_request_id, entry_id, purged_at)
    values (v_entry.owner_id, v_entry.create_request_id, v_entry.id, v_now)
    on conflict (owner_id, create_request_id) do nothing;

  insert into private.retained_generation_requests (owner_id, idempotency_key, request_hash)
  select g.owner_id, g.idempotency_key, g.request_hash
  from public.generations g
  where g.entry_id = p_entry_id and g.owner_id = v_owner_id;

  insert into private.retained_generation_ledger (
    generation_id, owner_id, generation_status, reservation_present,
    reserved_day, max_cost_micro_usd, reservation_state, archived_at
  )
  select g.id, g.owner_id, g.status, r.generation_id is not null,
    r.reserved_day, r.max_cost_micro_usd, r.state, v_now
  from public.generations g
  left join private.reservations r on r.generation_id = g.id and r.owner_id = g.owner_id
  where g.entry_id = p_entry_id and g.owner_id = v_owner_id
  on conflict (generation_id) do nothing;

  insert into private.retained_provider_attempts (
    attempt_id, generation_id, owner_id, stage, call_index, is_mock,
    state, request_id, started_at, finished_at, archived_at
  )
  select a.id, a.generation_id, a.owner_id, a.stage, a.call_index, a.is_mock,
    a.state, a.request_id, a.started_at, a.finished_at, v_now
  from private.provider_attempts a
  join public.generations g on g.id = a.generation_id and g.owner_id = a.owner_id
  where g.entry_id = p_entry_id and g.owner_id = v_owner_id
  on conflict (attempt_id) do nothing;

  delete from private.provider_attempts a
    using public.generations g
    where a.generation_id = g.id and a.owner_id = g.owner_id
      and g.entry_id = p_entry_id and g.owner_id = v_owner_id;
  delete from private.reservations r
    using public.generations g
    where r.generation_id = g.id and r.owner_id = g.owner_id
      and g.entry_id = p_entry_id and g.owner_id = v_owner_id;
  delete from public.assets a
    using public.generations g
    where a.generation_id = g.id and a.owner_id = g.owner_id
      and g.entry_id = p_entry_id and g.owner_id = v_owner_id;
  update public.entries set latest_generation_id = null
    where id = p_entry_id and owner_id = v_owner_id;
  delete from public.generations g where g.entry_id = p_entry_id and g.owner_id = v_owner_id;
  delete from private.retention_cleanup_leases l where l.entry_id = p_entry_id;
  delete from public.entries e where e.id = p_entry_id and e.owner_id = v_owner_id;
  return true;
end;
$$;

revoke all on function public.claim_retention_cleanup(integer) from public, anon, authenticated;
revoke all on function public.finalize_retention_cleanup(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_retention_cleanup(integer) to service_role;
grant execute on function public.finalize_retention_cleanup(uuid, uuid, boolean) to service_role;

commit;
