begin;

create function private.is_valid_openai_generation_profile(value jsonb)
returns boolean language plpgsql immutable strict security invoker set search_path = ''
as $$
begin
  if not private.is_valid_generation_profile(value)
    or value = '{}'::jsonb
    or (select count(*) from pg_catalog.jsonb_object_keys(value)) <> 8
    or value -> 'profile_id' is distinct from pg_catalog.to_jsonb(
      'openai-script-gpt-4.1-mini-2025-04-14+image-gpt-image-2.5-flare-bw-v1'::text
    )
    or value -> 'is_mock' is distinct from 'false'::jsonb
    or value -> 'max_cost_micro_usd' is null
    or (value ->> 'max_cost_micro_usd') !~ '^[1-9][0-9]*$'
    or value -> 'max_image_calls' is distinct from '4'::jsonb
    or value -> 'provider' is distinct from pg_catalog.to_jsonb('openai'::text)
    or value -> 'script_model' is distinct from pg_catalog.to_jsonb('gpt-4.1-mini-2025-04-14'::text)
    or value -> 'image_model' is distinct from pg_catalog.to_jsonb('gpt-image-2.5-flare'::text)
    or value -> 'color_mode' is distinct from pg_catalog.to_jsonb('monochrome'::text) then
    return false;
  end if;
  return true;
exception
  when others then return false;
end;
$$;
revoke all on function private.is_valid_openai_generation_profile(jsonb)
  from public, anon, authenticated;
grant execute on function private.is_valid_openai_generation_profile(jsonb) to service_role;

create function public.reserve_openai_generation(
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
  v_policy private.generation_policy;
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

  if p_generation_enabled is distinct from true then
    raise exception using message = 'GENERATION_DISABLED';
  end if;

  select * into v_policy from private.generation_policy p where p.id = 1;
  if not found or not v_policy.enabled
    or not private.is_valid_openai_generation_profile(v_policy.model_profile_json) then
    raise exception using message = 'GENERATION_DISABLED';
  end if;

  return public.reserve_generation(
    p_actor_id, p_entry_id, p_expected_revision, p_idempotency_key, p_generation_enabled
  );
end;
$$;
revoke all on function public.reserve_openai_generation(uuid, uuid, integer, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.reserve_openai_generation(uuid, uuid, integer, uuid, boolean)
  to service_role;

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
  v_generation_available := v_policy.enabled
    and v_profile_supported
    and v_active_generation_id is null
    and v_remaining > 0
    and coalesce(v_global_total.count, 0) < v_policy.global_total_limit
    and coalesce(v_global_day.count, 0) < v_policy.global_daily_limit
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

create or replace function public.claim_generation(p_generation_id uuid)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_claim_token uuid;
  v_deadline timestamptz;
  v_now timestamptz;
begin
  if p_generation_id is null then raise exception using message = 'INVALID_INPUT'; end if;

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

  if v_generation.status <> 'queued' or v_reservation.state <> 'reserved'
    or v_generation.cancel_requested or v_entry.deleted_at is not null
    or v_entry.expires_at <= v_now
    or v_generation.is_mock is null then
    return null;
  end if;
  if v_generation.claim_token is not null or v_generation.deadline_at is not null then
    return null;
  end if;

  v_claim_token := pg_catalog.gen_random_uuid();
  v_deadline := v_now + interval '15 minutes';
  update public.generations set status = 'running', stage = 'script',
    claim_token = v_claim_token, deadline_at = v_deadline,
    started_at = coalesce(started_at, v_now),
    updated_at = v_now
    where id = p_generation_id;

  return pg_catalog.jsonb_build_object(
    'generation_id', v_generation.id,
    'entry_id', v_generation.entry_id,
    'owner_id', v_generation.owner_id,
    'entry_revision', v_generation.entry_revision,
    'diary_date', v_entry.diary_date,
    'is_mock', v_generation.is_mock,
    'input_snapshot', v_generation.input_snapshot,
    'model_profile_snapshot', v_generation.model_profile_snapshot,
    'claim_token', v_claim_token,
    'deadline_at', v_deadline
  );
end;
$$;
revoke all on function public.claim_generation(uuid) from public, anon, authenticated;
grant execute on function public.claim_generation(uuid) to service_role;

create function public.mark_generation_saving(
  p_generation_id uuid,
  p_claim_token uuid
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_attempt_count integer;
  v_succeeded_count integer;
  v_now timestamptz;
begin
  if p_generation_id is null or p_claim_token is null then
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
  if v_generation.is_mock is distinct from false
    or not private.is_valid_openai_generation_profile(v_generation.model_profile_snapshot) then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  if v_reservation.state <> 'reserved'
    or v_reservation.max_cost_micro_usd is distinct from
      (v_generation.model_profile_snapshot ->> 'max_cost_micro_usd')::bigint then
    raise exception using message = 'QUOTA_LEDGER_INCONSISTENT';
  end if;

  select count(*), count(*) filter (where not a.is_mock and a.state = 'succeeded'
    and ((a.stage = 'script' and a.call_index = 1)
      or (a.stage = 'images' and a.call_index between 1 and 4)))
    into v_attempt_count, v_succeeded_count
    from private.provider_attempts a where a.generation_id = p_generation_id;
  if v_attempt_count <> 5 or v_succeeded_count <> 5 then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;

  if v_generation.stage = 'saving' then
    return pg_catalog.jsonb_build_object(
      'generation_id', v_generation.id,
      'status', v_generation.status,
      'stage', v_generation.stage
    );
  end if;
  if v_generation.stage is distinct from 'images' then
    raise exception using message = 'STAGE_MISMATCH';
  end if;

  update public.generations set stage = 'saving', updated_at = v_now
    where id = p_generation_id;

  return pg_catalog.jsonb_build_object(
    'generation_id', p_generation_id,
    'status', 'running',
    'stage', 'saving'
  );
end;
$$;
revoke all on function public.mark_generation_saving(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_generation_saving(uuid, uuid) to service_role;

create or replace function public.list_generation_reconcile_candidates(p_limit integer default 25)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_candidates jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception using message = 'INVALID_INPUT';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'generation_id', candidate.id,
      'action', case
        when candidate.status = 'running' then 'expire'
        when candidate.cancel_requested or not candidate.entry_is_live then 'cancel'
        else 'enqueue'
      end
    ) order by candidate.settlement_priority, candidate.updated_at, candidate.id
  ), '[]'::jsonb)
  into v_candidates
  from (
    select g.id, g.status, g.cancel_requested, g.updated_at,
      case
        when g.status = 'running' and g.stage = 'saving' and g.is_mock is false
          and not g.cancel_requested
          and private.is_valid_openai_generation_profile(g.model_profile_snapshot)
          and exists (
            select 1 from public.entries e
            where e.id = g.entry_id and e.owner_id = g.owner_id
              and private.is_live_generation_entry(e)
          ) then 1
        when g.status = 'queued' and not g.cancel_requested and exists (
          select 1 from public.entries e
          where e.id = g.entry_id and e.owner_id = g.owner_id
            and private.is_live_generation_entry(e)
        ) then 2
        else 0
      end as settlement_priority,
      exists (
        select 1 from public.entries e
        where e.id = g.entry_id and e.owner_id = g.owner_id
          and private.is_live_generation_entry(e)
      ) as entry_is_live
    from public.generations g
    where (g.status = 'queued' and (
        g.cancel_requested
        or not exists (
          select 1 from public.entries e
          where e.id = g.entry_id and e.owner_id = g.owner_id
            and private.is_live_generation_entry(e)
        )
        or coalesce(g.enqueued_at, g.created_at) <= pg_catalog.statement_timestamp() - interval '1 minute'
      ))
      or (g.status = 'running' and g.deadline_at <= pg_catalog.statement_timestamp())
    order by settlement_priority, g.updated_at, g.id
    limit p_limit
  ) candidate;
  return v_candidates;
end;
$$;
revoke all on function public.list_generation_reconcile_candidates(integer)
  from public, anon, authenticated;
grant execute on function public.list_generation_reconcile_candidates(integer)
  to service_role;

create function public.list_generation_reconcile_candidates_v2(p_limit integer default 25)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_existing_candidates jsonb;
  v_candidates jsonb;
begin
  v_existing_candidates := public.list_generation_reconcile_candidates(p_limit);

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'generation_id', candidate.value -> 'generation_id',
      'action', case
        when candidate.value ->> 'action' = 'expire'
          and generation.status = 'running'
          and generation.stage = 'saving'
          and generation.is_mock is false
          and private.is_valid_openai_generation_profile(generation.model_profile_snapshot)
          and not generation.cancel_requested
          and entry.id is not null
          and entry.deleted_at is null
          and entry.expires_at > pg_catalog.statement_timestamp()
        then 'recover-saving'
        else candidate.value ->> 'action'
      end
    ) order by candidate.ordinality
  ), '[]'::jsonb)
  into v_candidates
  from pg_catalog.jsonb_array_elements(v_existing_candidates) with ordinality
    as candidate(value, ordinality)
  left join public.generations generation
    on generation.id = (candidate.value ->> 'generation_id')::uuid
  left join public.entries entry
    on entry.id = generation.entry_id and entry.owner_id = generation.owner_id;

  return v_candidates;
end;
$$;
revoke all on function public.list_generation_reconcile_candidates_v2(integer)
  from public, anon, authenticated;
grant execute on function public.list_generation_reconcile_candidates_v2(integer)
  to service_role;

commit;
