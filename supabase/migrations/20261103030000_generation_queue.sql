begin;

create function public.reserve_mock_generation(
  p_actor_id uuid,
  p_entry_id uuid,
  p_expected_revision integer,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_receipt jsonb;
  v_policy private.generation_policy;
begin
  if p_actor_id is null then raise exception using message = 'AUTH_REQUIRED'; end if;

  v_receipt := public.find_generation_receipt(
    p_actor_id, p_entry_id, p_expected_revision, p_idempotency_key
  );
  if v_receipt is not null then return v_receipt; end if;

  perform pg_catalog.pg_advisory_xact_lock(20261103, 10001);
  v_receipt := public.find_generation_receipt(
    p_actor_id, p_entry_id, p_expected_revision, p_idempotency_key
  );
  if v_receipt is not null then return v_receipt; end if;

  select * into v_policy from private.generation_policy p where p.id = 1;
  if not found or not v_policy.enabled or v_policy.model_profile_json = '{}'::jsonb
    or not private.is_valid_generation_profile(v_policy.model_profile_json)
    or v_policy.model_profile_json -> 'is_mock' is distinct from 'true'::jsonb then
    raise exception using message = 'GENERATION_DISABLED';
  end if;

  return public.reserve_generation(
    p_actor_id, p_entry_id, p_expected_revision, p_idempotency_key, true
  );
end;
$$;
revoke all on function public.reserve_mock_generation(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_mock_generation(uuid, uuid, integer, uuid)
  to service_role;

create function public.get_generation_quota(p_actor_id uuid)
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
  v_profile_is_mock := v_policy.model_profile_json -> 'is_mock' = 'true'::jsonb
    and v_policy.model_profile_json <> '{}'::jsonb
    and private.is_valid_generation_profile(v_policy.model_profile_json);
  if v_profile_is_mock then
    v_cost := (v_policy.model_profile_json ->> 'max_cost_micro_usd')::bigint;
  end if;
  v_generation_available := v_policy.enabled
    and v_profile_is_mock
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

create function private.is_valid_mock_comic(value jsonb, expected_asset_id uuid)
returns boolean language plpgsql immutable strict security invoker set search_path = ''
as $$
declare
  v_panel jsonb;
  v_index integer;
begin
  if pg_catalog.jsonb_typeof(value) is distinct from 'object'
    or (select count(*) from pg_catalog.jsonb_object_keys(value)) <> 4
    or value -> 'schemaVersion' is distinct from '1'::jsonb
    or pg_catalog.jsonb_typeof(value -> 'title') is distinct from 'string'
    or pg_catalog.char_length(value ->> 'title') not between 1 and 40
    or pg_catalog.jsonb_typeof(value -> 'panels') is distinct from 'array'
    or pg_catalog.jsonb_array_length(value -> 'panels') <> 4
    or pg_catalog.jsonb_typeof(value -> 'visual') is distinct from 'object'
    or (select count(*) from pg_catalog.jsonb_object_keys(value -> 'visual')) <> 3
    or value #>> '{visual,kind}' is distinct from 'page'
    or value #>> '{visual,assetId}' is distinct from expected_asset_id::text
    or value #>> '{visual,textMode}' is distinct from 'external' then
    return false;
  end if;

  for v_index in 0..3 loop
    v_panel := value -> 'panels' -> v_index;
    if pg_catalog.jsonb_typeof(v_panel) is distinct from 'object'
      or (select count(*) from pg_catalog.jsonb_object_keys(v_panel)) <> 4
      or v_panel -> 'index' is distinct from pg_catalog.to_jsonb(v_index + 1)
      or pg_catalog.jsonb_typeof(v_panel -> 'scene') is distinct from 'string'
      or pg_catalog.char_length(v_panel ->> 'scene') not between 1 and 250
      or pg_catalog.jsonb_typeof(v_panel -> 'caption') is distinct from 'string'
      or pg_catalog.char_length(v_panel ->> 'caption') > 70
      or pg_catalog.jsonb_typeof(v_panel -> 'dialogue') is distinct from 'string'
      or pg_catalog.char_length(v_panel ->> 'dialogue') > 70 then
      return false;
    end if;
  end loop;
  return true;
exception
  when others then return false;
end;
$$;
revoke all on function private.is_valid_mock_comic(jsonb, uuid) from public, anon, authenticated;
grant execute on function private.is_valid_mock_comic(jsonb, uuid) to service_role;

create function public.complete_mock_generation(
  p_generation_id uuid,
  p_claim_token uuid,
  p_comic_json jsonb
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_attempt_count integer;
  v_now timestamptz;
begin
  if p_generation_id is null or p_claim_token is null or p_comic_json is null then
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
  if v_generation.cancel_requested or v_entry.deleted_at is not null or v_entry.expires_at <= v_now then
    raise exception using message = 'GENERATION_CANCELLED';
  end if;
  if v_generation.stage is distinct from 'images' then
    raise exception using message = 'STAGE_MISMATCH';
  end if;
  if v_generation.is_mock is distinct from true
    or v_generation.model_profile_snapshot = '{}'::jsonb
    or not private.is_valid_generation_profile(v_generation.model_profile_snapshot)
    or v_generation.model_profile_snapshot -> 'is_mock' is distinct from 'true'::jsonb then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  if v_reservation.state <> 'reserved' then
    raise exception using message = 'GENERATION_TERMINAL';
  end if;
  if not private.is_valid_mock_comic(p_comic_json, v_generation.id) then
    raise exception using message = 'INVALID_INPUT';
  end if;

  select count(*) into v_attempt_count from private.provider_attempts a
    where a.generation_id = p_generation_id and a.is_mock
      and ((a.stage = 'script' and a.call_index = 1 and a.state = 'succeeded')
        or (a.stage = 'images' and a.call_index = 1 and a.state = 'succeeded'));
  if v_attempt_count <> 2 or exists (
    select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id
      and (not a.is_mock or a.state <> 'succeeded'
        or (a.stage, a.call_index) not in (('script', 1), ('images', 1)))
  ) then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;

  update private.reservations set state = 'consumed'
    where generation_id = p_generation_id and state = 'reserved';
  if not found then raise exception using message = 'QUOTA_LEDGER_INCONSISTENT'; end if;
  update public.generations set status = 'succeeded', stage = null,
    comic_json = p_comic_json, error_code = null,
    completed_at = v_now, updated_at = v_now
    where id = p_generation_id;

  return pg_catalog.jsonb_build_object(
    'generation_id', p_generation_id,
    'status', 'succeeded',
    'reservation_state', 'consumed'
  );
end;
$$;
revoke all on function public.complete_mock_generation(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_mock_generation(uuid, uuid, jsonb)
  to service_role;

create function public.mark_generation_enqueued(p_generation_id uuid)
returns boolean language plpgsql security invoker set search_path = ''
as $$
begin
  if p_generation_id is null then raise exception using message = 'INVALID_INPUT'; end if;
  update public.generations set enqueued_at = pg_catalog.statement_timestamp(),
    updated_at = pg_catalog.statement_timestamp()
    where id = p_generation_id and status = 'queued';
  return found;
end;
$$;
revoke all on function public.mark_generation_enqueued(uuid) from public, anon, authenticated;
grant execute on function public.mark_generation_enqueued(uuid) to service_role;

create function public.list_generation_reconcile_candidates(p_limit integer default 25)
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
    ) order by candidate.updated_at, candidate.id
  ), '[]'::jsonb)
  into v_candidates
  from (
    select g.id, g.status, g.cancel_requested, g.updated_at,
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
    order by g.updated_at, g.id
    limit p_limit
  ) candidate;
  return v_candidates;
end;
$$;
revoke all on function public.list_generation_reconcile_candidates(integer)
  from public, anon, authenticated;
grant execute on function public.list_generation_reconcile_candidates(integer)
  to service_role;

commit;
