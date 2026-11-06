begin;

create function public.parallel_image_generation_ready()
returns boolean language sql immutable security invoker set search_path = ''
as $$
  select true;
$$;

revoke all on function public.parallel_image_generation_ready()
  from public, anon, authenticated;
grant execute on function public.parallel_image_generation_ready() to service_role;

create function public.begin_parallel_image_attempts(
  p_generation_id uuid,
  p_claim_token uuid,
  p_generation_enabled boolean
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_policy private.generation_policy;
  v_now timestamptz;
  v_attempts jsonb;
begin
  if p_generation_id is null or p_claim_token is null or p_generation_enabled is null then
    raise exception using message = 'INVALID_INPUT';
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
  if p_generation_enabled is distinct from true then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  select * into v_policy from private.generation_policy p where p.id = 1;
  if not found or not v_policy.enabled then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  if exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.state in ('dispatched', 'unknown')) then
    raise exception using message = 'ATTEMPT_UNRESOLVED';
  end if;
  if not exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = 'script'
      and a.call_index = 1 and a.state = 'succeeded' and not a.is_mock)
    or not exists (select 1 from private.provider_attempts a
      where a.generation_id = p_generation_id and a.stage = 'images'
        and a.call_index = 1 and a.state = 'succeeded' and not a.is_mock) then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;
  if v_generation.stage is distinct from 'images' then
    raise exception using message = 'STAGE_MISMATCH';
  end if;
  if exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = 'images' and a.call_index between 2 and 4) then
    raise exception using message = 'ATTEMPT_ALREADY_BEGUN';
  end if;

  with inserted as (
    insert into private.provider_attempts (
      generation_id, owner_id, stage, call_index, is_mock, state, started_at
    )
    select v_generation.id, v_generation.owner_id, 'images', calls.call_index,
      false, 'dispatched', v_now
    from pg_catalog.generate_series(2, 4) as calls(call_index)
    returning id, generation_id, stage, call_index, is_mock
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'attempt_id', inserted.id,
      'generation_id', inserted.generation_id,
      'stage', inserted.stage,
      'call_index', inserted.call_index,
      'mode', 'provider',
      'is_mock', inserted.is_mock
    ) order by inserted.call_index)
    into v_attempts
    from inserted;

  return v_attempts;
exception
  when unique_violation then raise exception using message = 'ATTEMPT_ALREADY_BEGUN';
end;
$$;

revoke all on function public.begin_parallel_image_attempts(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.begin_parallel_image_attempts(uuid, uuid, boolean)
  to service_role;

commit;
