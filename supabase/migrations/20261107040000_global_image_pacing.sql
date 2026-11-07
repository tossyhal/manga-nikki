begin;

create table private.image_provider_pacing (
  singleton boolean primary key default true check (singleton),
  next_slot_at timestamptz not null
    check (next_slot_at > '-infinity'::timestamptz and next_slot_at < 'infinity'::timestamptz),
  slot_interval_ms integer not null default 500 check (slot_interval_ms = 500),
  max_batch_size integer not null default 3 check (max_batch_size = 3)
);
alter table private.image_provider_pacing enable row level security;
alter table private.image_provider_pacing force row level security;
revoke all on private.image_provider_pacing from public, anon, authenticated, service_role;
grant select, update (next_slot_at) on private.image_provider_pacing to service_role;
insert into private.image_provider_pacing (singleton, next_slot_at)
values (true, pg_catalog.clock_timestamp());

create function public.global_image_pacing_ready()
returns boolean language sql volatile security invoker set search_path = ''
as $$
  select exists (
    select 1 from private.image_provider_pacing p
    where p.singleton
      and p.slot_interval_ms = 500
      and p.max_batch_size = 3
      and p.next_slot_at <= pg_catalog.clock_timestamp() + interval '2 seconds'
  );
$$;

revoke all on function public.global_image_pacing_ready()
  from public, anon, authenticated;
grant execute on function public.global_image_pacing_ready() to service_role;

create function public.begin_paced_image_attempts(
  p_generation_id uuid,
  p_claim_token uuid,
  p_call_indices integer[],
  p_generation_enabled boolean
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_policy private.generation_policy;
  v_pacing private.image_provider_pacing;
  v_now timestamptz;
  v_wait_ms integer;
  v_attempt jsonb;
  v_attempts jsonb;
  v_weight integer;
  v_last_call_index integer;
begin
  if p_generation_id is null or p_claim_token is null or p_call_indices is null
    or p_generation_enabled is null
    or pg_catalog.cardinality(p_call_indices) not in (1, 3)
    or pg_catalog.array_ndims(p_call_indices) <> 1
    or pg_catalog.array_lower(p_call_indices, 1) <> 1 then
    raise exception using message = 'INVALID_INPUT';
  end if;
  if pg_catalog.array_position(p_call_indices, null) is not null then
    raise exception using message = 'INVALID_INPUT';
  end if;
  if pg_catalog.cardinality(p_call_indices) = 1 then
    if p_call_indices[1] is null or p_call_indices[1] not between 1 and 4 then
      raise exception using message = 'INVALID_INPUT';
    end if;
    v_weight := 1;
  else
    if p_call_indices is distinct from array[2, 3, 4] then
      raise exception using message = 'INVALID_INPUT';
    end if;
    v_weight := 3;
  end if;
  if p_generation_enabled is distinct from true then
    raise exception using message = 'GENERATION_DISABLED';
  end if;

  select * into v_generation from public.generations g where g.id = p_generation_id;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  v_reservation := private.lock_generation_quota(p_generation_id);

  select * into v_entry from public.entries e
    where e.id = v_generation.entry_id and e.owner_id = v_generation.owner_id for update;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  select * into v_generation from public.generations g where g.id = p_generation_id for update;
  select * into v_reservation from private.reservations r
    where r.generation_id = p_generation_id for update;
  select * into v_pacing from private.image_provider_pacing p
    where p.singleton for update;
  if not found then raise exception using message = 'IMAGE_PACING_NOT_READY'; end if;

  v_now := pg_catalog.clock_timestamp();
  if v_generation.status <> 'running'
    or v_generation.claim_token is distinct from p_claim_token then
    raise exception using message = 'CLAIM_LOST';
  end if;
  if v_generation.deadline_at is null or v_generation.deadline_at <= v_now then
    raise exception using message = 'CLAIM_EXPIRED';
  end if;
  if v_generation.cancel_requested or v_entry.deleted_at is not null
    or v_entry.expires_at <= v_now then
    raise exception using message = 'GENERATION_CANCELLED';
  end if;
  if v_reservation.state <> 'reserved' then
    raise exception using message = 'GENERATION_TERMINAL';
  end if;
  if v_generation.is_mock is distinct from false
    or not private.is_valid_openai_generation_profile(v_generation.model_profile_snapshot) then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  select * into v_policy from private.generation_policy p where p.id = 1;
  if not found or not v_policy.enabled then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  if v_pacing.slot_interval_ms <> 500 or v_pacing.max_batch_size <> 3
    or v_pacing.next_slot_at > v_now + interval '2 seconds' then
    raise exception using message = 'IMAGE_PACING_NOT_READY';
  end if;
  if exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.state in ('dispatched', 'unknown')) then
    raise exception using message = 'ATTEMPT_UNRESOLVED';
  end if;
  if not exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = 'script'
      and a.call_index = 1 and a.state = 'succeeded' and not a.is_mock) then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;
  if exists (select 1 from pg_catalog.unnest(p_call_indices) requested(call_index)
    where requested.call_index > coalesce(
      (v_generation.model_profile_snapshot ->> 'max_image_calls')::integer, 1)) then
    raise exception using message = 'ATTEMPT_LIMIT_REACHED';
  end if;
  if exists (select 1 from pg_catalog.unnest(p_call_indices) requested(call_index)
    join private.provider_attempts a on a.generation_id = p_generation_id
      and a.stage = 'images' and a.call_index = requested.call_index) then
    raise exception using message = 'ATTEMPT_ALREADY_BEGUN';
  end if;
  select pg_catalog.max(a.call_index) into v_last_call_index
    from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = 'images';
  if v_weight = 1 then
    if p_call_indices[1] <> coalesce(v_last_call_index, 0) + 1 then
      raise exception using message = 'ATTEMPT_ORDER_INVALID';
    end if;
    if v_last_call_index > 0 and not exists (
      select 1 from private.provider_attempts a
      where a.generation_id = p_generation_id and a.stage = 'images'
        and a.call_index = v_last_call_index and a.state = 'succeeded'
    ) then
      raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
    end if;
  else
    if v_generation.stage is distinct from 'images'
      or v_last_call_index is distinct from 1
      or not exists (select 1 from private.provider_attempts a
        where a.generation_id = p_generation_id and a.stage = 'images'
          and a.call_index = 1 and a.state = 'succeeded' and not a.is_mock) then
      raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
    end if;
  end if;

  if v_now < v_pacing.next_slot_at then
    v_wait_ms := greatest(1,
      pg_catalog.ceil(extract(epoch from (v_pacing.next_slot_at - v_now)) * 1000)::integer);
    return pg_catalog.jsonb_build_object('status', 'waiting', 'wait_ms', v_wait_ms);
  end if;

  update private.image_provider_pacing
    set next_slot_at = v_now + (v_pacing.slot_interval_ms * v_weight) * interval '1 millisecond'
    where singleton;

  if v_weight = 1 then
    v_attempt := public.begin_provider_attempt(
      p_generation_id, p_claim_token, 'images', p_call_indices[1], true);
    v_attempts := pg_catalog.jsonb_build_array(v_attempt);
  else
    v_attempts := public.begin_parallel_image_attempts(
      p_generation_id, p_claim_token, true);
  end if;

  return pg_catalog.jsonb_build_object('status', 'ready', 'attempts', v_attempts);
end;
$$;

revoke all on function public.begin_paced_image_attempts(uuid, uuid, integer[], boolean)
  from public, anon, authenticated;
grant execute on function public.begin_paced_image_attempts(uuid, uuid, integer[], boolean)
  to service_role;

commit;
