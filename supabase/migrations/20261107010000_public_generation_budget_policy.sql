begin;

alter table private.generation_policy
  alter column global_daily_limit drop not null,
  alter column global_total_limit drop not null,
  add column daily_limit_exempt_owners uuid[] not null default '{}'::uuid[]
    check (pg_catalog.array_position(daily_limit_exempt_owners, null) is null);

create or replace function private.reserve_generation_existing_key(
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
  -- Completion also locks this entry, so its committed success is visible before a new reservation.
  if exists (
    select 1 from public.generations g
    where g.entry_id = p_entry_id
      and g.owner_id = p_actor_id
      and g.entry_revision = p_expected_revision
      and g.status = 'succeeded'
  ) then
    raise exception using message = 'REVISION_ALREADY_GENERATED';
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

  if (v_policy.global_total_limit is not null
      and v_global_total.count >= v_policy.global_total_limit)
    or (v_policy.global_daily_limit is not null
      and v_global_day.count >= v_policy.global_daily_limit)
    or v_cost > v_policy.budget_micro_usd
    or v_global_total.committed_micro_usd > v_policy.budget_micro_usd - v_cost then
    raise exception using message = 'GLOBAL_LIMIT_REACHED';
  end if;
  if not (p_actor_id = any(v_policy.daily_limit_exempt_owners))
    and v_user_day.count >= v_policy.user_daily_limit then
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

create or replace function public.get_generation_quota(p_actor_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_policy private.generation_policy;
  v_day date := (pg_catalog.statement_timestamp() at time zone 'Asia/Tokyo')::date;
  v_user_count bigint := 0;
  v_global_total private.quota_counters;
  v_global_day private.quota_counters;
  v_active_generation_id uuid;
  v_remaining bigint;
  v_cost bigint := 0;
  v_profile_is_mock boolean := false;
  v_profile_supported boolean := false;
  v_generation_available boolean := false;
  v_reset_at timestamptz;
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;

  select * into v_policy from private.generation_policy p where p.id = 1;
  if not found then raise exception using message = 'GENERATION_DISABLED'; end if;

  select c.count into v_user_count from private.quota_counters c
    where c.scope = 'user_day' and c.subject = p_actor_id and c.day_key = v_day;
  v_user_count := coalesce(v_user_count, 0);
  select * into v_global_total from private.quota_counters c
    where c.scope = 'global_total' and c.subject is null and c.day_key is null;
  select * into v_global_day from private.quota_counters c
    where c.scope = 'global_day' and c.subject is null and c.day_key = v_day;
  select g.id into v_active_generation_id from public.generations g
    where g.owner_id = p_actor_id and g.status in ('queued', 'running')
    order by g.created_at desc, g.id desc limit 1;

  v_remaining := greatest(0, v_policy.user_daily_limit - v_user_count);
  v_reset_at := ((v_day + 1)::timestamp without time zone at time zone 'Asia/Tokyo');
  if v_policy.model_profile_json <> '{}'::jsonb
    and private.is_valid_generation_profile(v_policy.model_profile_json) then
    v_profile_is_mock := v_policy.model_profile_json -> 'is_mock' = 'true'::jsonb;
    v_cost := (v_policy.model_profile_json ->> 'max_cost_micro_usd')::bigint;
    v_profile_supported := v_profile_is_mock
      or private.is_valid_openai_generation_profile(v_policy.model_profile_json);
  end if;
  -- 非公開の例外owner一覧を返さず、v1の有限整数quotaを維持する。
  if p_actor_id = any(v_policy.daily_limit_exempt_owners) then
    v_remaining := case
      when not v_profile_supported then 0
      when v_cost = 0 then 1
      else least(9007199254740991::bigint,
        greatest(0, v_policy.budget_micro_usd
          - coalesce(v_global_total.committed_micro_usd, 0)) / v_cost)
    end;
  end if;
  v_generation_available := v_policy.enabled
    and v_profile_supported
    and v_active_generation_id is null
    and v_remaining > 0
    and (v_policy.global_total_limit is null
      or coalesce(v_global_total.count, 0) < v_policy.global_total_limit)
    and (v_policy.global_daily_limit is null
      or coalesce(v_global_day.count, 0) < v_policy.global_daily_limit)
    and v_cost <= v_policy.budget_micro_usd
    and coalesce(v_global_total.committed_micro_usd, 0) <= v_policy.budget_micro_usd - v_cost;

  return pg_catalog.jsonb_build_object(
    'remaining_today', v_remaining,
    'active_generation_id', v_active_generation_id,
    'reset_at', v_reset_at,
    'generation_available', v_generation_available,
    'profile_is_mock', v_profile_is_mock
  );
end;
$$;
revoke all on function public.get_generation_quota(uuid) from public, anon, authenticated;
grant execute on function public.get_generation_quota(uuid) to service_role;

commit;
