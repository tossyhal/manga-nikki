begin;

create function private.is_valid_generation_profile(value jsonb)
returns boolean language plpgsql immutable strict security invoker set search_path = ''
as $$
declare
  v_cost_text text;
  v_cost numeric;
begin
  if pg_catalog.jsonb_typeof(value) is distinct from 'object' then return false; end if;
  if value = '{}'::jsonb then return true; end if;
  if pg_catalog.jsonb_typeof(value -> 'profile_id') is distinct from 'string'
    or pg_catalog.btrim(value ->> 'profile_id') = '' then return false; end if;
  if pg_catalog.jsonb_typeof(value -> 'is_mock') is distinct from 'boolean' then return false; end if;
  if pg_catalog.jsonb_typeof(value -> 'max_cost_micro_usd') is distinct from 'number' then return false; end if;

  v_cost_text := value ->> 'max_cost_micro_usd';
  if v_cost_text !~ '^(0|[1-9][0-9]*)$' then return false; end if;
  v_cost := v_cost_text::numeric;
  if v_cost > 9223372036854775807 then return false; end if;
  if value ->> 'is_mock' = 'false' and v_cost = 0 then return false; end if;
  return true;
exception
  when numeric_value_out_of_range then return false;
end;
$$;
revoke all on function private.is_valid_generation_profile(jsonb) from public, anon, authenticated;
grant execute on function private.is_valid_generation_profile(jsonb) to service_role;

create function private.generation_request_hash(p_entry_id uuid, p_expected_revision integer)
returns text language sql immutable strict security invoker set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'apiVersion', 'v1',
      'entryId', p_entry_id,
      'expectedRevision', p_expected_revision
    )::text, 'UTF8')),
    'hex'
  );
$$;
revoke all on function private.generation_request_hash(uuid, integer) from public, anon, authenticated;
grant execute on function private.generation_request_hash(uuid, integer) to service_role;

create function private.is_live_generation_entry(value public.entries)
returns boolean language sql stable strict security invoker set search_path = ''
as $$
  select (value).deleted_at is null and (value).expires_at > pg_catalog.statement_timestamp();
$$;
revoke all on function private.is_live_generation_entry(public.entries) from public, anon, authenticated;
grant execute on function private.is_live_generation_entry(public.entries) to service_role;

alter table public.generations add constraint generations_id_owner_unique unique (id, owner_id);

create table private.generation_policy (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  user_daily_limit bigint not null default 2 check (user_daily_limit >= 0),
  global_daily_limit bigint not null default 0 check (global_daily_limit >= 0),
  global_total_limit bigint not null default 0 check (global_total_limit >= 0),
  budget_micro_usd bigint not null default 0 check (budget_micro_usd >= 0),
  model_profile_json jsonb not null default '{}'::jsonb
    check (private.is_valid_generation_profile(model_profile_json))
);
alter table private.generation_policy enable row level security;
insert into private.generation_policy (id) values (1);

create function private.lock_generation_policy_update()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(20261103, 10001);
  return null;
end;
$$;
revoke all on function private.lock_generation_policy_update() from public, anon, authenticated, service_role;
create trigger generation_policy_serialize_update
  before update on private.generation_policy
  for each statement execute function private.lock_generation_policy_update();

create table private.quota_counters (
  scope text not null check (scope in ('global_total', 'global_day', 'user_day')),
  subject uuid,
  day_key date,
  count bigint not null default 0 check (count >= 0),
  committed_micro_usd bigint not null default 0 check (committed_micro_usd >= 0),
  constraint quota_counters_scope_key check (
    (scope = 'global_total' and subject is null and day_key is null)
    or (scope = 'global_day' and subject is null and day_key is not null)
    or (scope = 'user_day' and subject is not null and day_key is not null)
  ),
  constraint quota_counters_unique_key unique nulls not distinct (scope, subject, day_key)
);
alter table private.quota_counters enable row level security;

create table private.reservations (
  generation_id uuid primary key,
  owner_id uuid not null,
  reserved_day date not null,
  max_cost_micro_usd bigint not null check (max_cost_micro_usd >= 0),
  state text not null default 'reserved'
    check (state in ('reserved', 'consumed', 'held', 'released')),
  created_at timestamptz not null default statement_timestamp(),
  foreign key (generation_id, owner_id)
    references public.generations(id, owner_id)
);
alter table private.reservations enable row level security;
create index reservations_owner_day on private.reservations (owner_id, reserved_day);

revoke all on private.generation_policy, private.quota_counters, private.reservations
  from public, anon, authenticated, service_role;
grant select on private.generation_policy to service_role;
grant select, insert, update on private.quota_counters to service_role;
grant select, insert on private.reservations to service_role;

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
  v_policy private.generation_policy;
  v_global_total private.quota_counters;
  v_global_day private.quota_counters;
  v_user_day private.quota_counters;
  v_entry public.entries;
  v_generation public.generations;
  v_profile jsonb;
  v_cost bigint;
  v_is_mock boolean;
  v_day date := (statement_timestamp() at time zone 'Asia/Tokyo')::date;
  v_request_hash text;
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;
  if p_entry_id is null or p_expected_revision is null or p_expected_revision <= 0
    or p_idempotency_key is null then
    raise exception using message = 'INVALID_INPUT';
  end if;

  v_request_hash := private.generation_request_hash(p_entry_id, p_expected_revision);

  -- Retry lookup precedes both kill switches so a stopped service can return its original receipt.
  select * into v_generation from public.generations g
    where g.owner_id = p_actor_id and g.idempotency_key = p_idempotency_key;
  if found then
    select * into v_entry from public.entries e
      where e.id = p_entry_id and e.owner_id = p_actor_id for update;
    if not found or not private.is_live_generation_entry(v_entry) then
      raise exception using message = 'NOT_FOUND';
    end if;
    if v_generation.request_hash is distinct from v_request_hash then
      raise exception using message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return pg_catalog.jsonb_build_object(
      'generation_id', v_generation.id,
      'status', v_generation.status,
      'status_url', '/api/v1/generations/' || v_generation.id::text
    );
  end if;

  -- Match the policy-update trigger without granting UPDATE merely to acquire a row lock.
  perform pg_catalog.pg_advisory_xact_lock(20261103, 10001);
  -- Recheck after waiting for policy changes so an accepted request survives a concurrent stop.
  select * into v_generation from public.generations g
    where g.owner_id = p_actor_id and g.idempotency_key = p_idempotency_key;
  if found then
    select * into v_entry from public.entries e
      where e.id = p_entry_id and e.owner_id = p_actor_id for update;
    if not found or not private.is_live_generation_entry(v_entry) then
      raise exception using message = 'NOT_FOUND';
    end if;
    if v_generation.request_hash is distinct from v_request_hash then
      raise exception using message = 'IDEMPOTENCY_CONFLICT';
    end if;
    return pg_catalog.jsonb_build_object(
      'generation_id', v_generation.id,
      'status', v_generation.status,
      'status_url', '/api/v1/generations/' || v_generation.id::text
    );
  end if;

  if p_generation_enabled is distinct from true then
    raise exception using message = 'GENERATION_DISABLED';
  end if;

  -- The global-total counter serializes admissions and makes the final slot atomic.
  select * into v_policy from private.generation_policy p where p.id = 1;
  if not found or not v_policy.enabled then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  v_profile := v_policy.model_profile_json;
  if v_profile = '{}'::jsonb or not private.is_valid_generation_profile(v_profile) then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  v_cost := (v_profile ->> 'max_cost_micro_usd')::bigint;
  v_is_mock := (v_profile ->> 'is_mock')::boolean;

  -- Create missing rows before locking them, always in the documented lock order.
  insert into private.quota_counters (scope, subject, day_key)
    values ('global_total', null, null) on conflict do nothing;
  insert into private.quota_counters (scope, subject, day_key)
    values ('global_day', null, v_day) on conflict do nothing;
  insert into private.quota_counters (scope, subject, day_key)
    values ('user_day', p_actor_id, v_day) on conflict do nothing;

  select * into v_global_total from private.quota_counters c
    where c.scope = 'global_total' and c.subject is null and c.day_key is null for update;
  select * into v_global_day from private.quota_counters c
    where c.scope = 'global_day' and c.subject is null and c.day_key = v_day for update;
  select * into v_user_day from private.quota_counters c
    where c.scope = 'user_day' and c.subject = p_actor_id and c.day_key = v_day for update;

  select * into v_entry from public.entries e
    where e.id = p_entry_id and e.owner_id = p_actor_id for update;
  if not found or not private.is_live_generation_entry(v_entry) then
    raise exception using message = 'NOT_FOUND';
  end if;
  if v_entry.consent_version is distinct from 'v1' then
    raise exception using message = 'CONSENT_REQUIRED';
  end if;
  if v_entry.revision is distinct from p_expected_revision then
    raise exception using message = 'REVISION_CONFLICT';
  end if;
  if exists (
    select 1 from public.generations g
    where g.entry_id = p_entry_id and g.owner_id = p_actor_id and g.status in ('queued', 'running')
  ) then
    raise exception using message = 'ENTRY_BUSY';
  end if;
  if exists (
    select 1 from public.generations g
    where g.owner_id = p_actor_id and g.status in ('queued', 'running')
  ) then
    raise exception using message = 'TOO_MANY_ACTIVE';
  end if;

  if v_global_total.count >= v_policy.global_total_limit
    or v_global_day.count >= v_policy.global_daily_limit
    or v_cost > v_policy.budget_micro_usd
    or v_global_total.committed_micro_usd > v_policy.budget_micro_usd - v_cost then
    raise exception using message = 'GLOBAL_LIMIT_REACHED';
  end if;
  if v_user_day.count >= v_policy.user_daily_limit then
    raise exception using message = 'USER_LIMIT_REACHED';
  end if;

  insert into public.generations (
    entry_id, owner_id, entry_revision, idempotency_key, request_hash,
    input_snapshot, model_profile_snapshot, is_mock, status, created_at, updated_at, enqueued_at
  ) values (
    v_entry.id, p_actor_id, v_entry.revision, p_idempotency_key, v_request_hash,
    v_entry.body, v_profile, v_is_mock, 'queued', statement_timestamp(), statement_timestamp(), statement_timestamp()
  ) returning * into v_generation;

  insert into private.reservations (
    generation_id, owner_id, reserved_day, max_cost_micro_usd, state
  ) values (
    v_generation.id, p_actor_id, v_day, v_cost, 'reserved'
  );

  update private.quota_counters set count = count + 1,
    committed_micro_usd = committed_micro_usd + v_cost
    where scope = 'global_total' and subject is null and day_key is null;
  update private.quota_counters set count = count + 1,
    committed_micro_usd = committed_micro_usd + v_cost
    where scope = 'global_day' and subject is null and day_key = v_day;
  update private.quota_counters set count = count + 1,
    committed_micro_usd = committed_micro_usd + v_cost
    where scope = 'user_day' and subject = p_actor_id and day_key = v_day;

  update public.entries set latest_generation_id = v_generation.id, updated_at = statement_timestamp()
    where id = v_entry.id and owner_id = p_actor_id;

  return pg_catalog.jsonb_build_object(
    'generation_id', v_generation.id,
    'status', v_generation.status,
    'status_url', '/api/v1/generations/' || v_generation.id::text
  );
end;
$$;

create function public.find_generation_receipt(
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

revoke all on function public.reserve_generation(uuid, uuid, integer, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.find_generation_receipt(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_generation(uuid, uuid, integer, uuid, boolean)
  to service_role;
grant execute on function public.find_generation_receipt(uuid, uuid, integer, uuid)
  to service_role;

commit;
