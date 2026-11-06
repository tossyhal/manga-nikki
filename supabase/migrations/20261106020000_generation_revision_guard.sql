begin;

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

commit;
