begin;

create or replace function private.is_valid_generation_profile(value jsonb)
returns boolean language plpgsql immutable strict security invoker set search_path = ''
as $$
declare
  v_cost_text text;
  v_cost numeric;
  v_image_calls_text text;
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

  if value ? 'max_image_calls' then
    if pg_catalog.jsonb_typeof(value -> 'max_image_calls') is distinct from 'number' then return false; end if;
    v_image_calls_text := value ->> 'max_image_calls';
    if v_image_calls_text !~ '^[1-4]$' then return false; end if;
  end if;
  return true;
exception
  when numeric_value_out_of_range then return false;
end;
$$;

create table private.provider_attempts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  generation_id uuid not null,
  owner_id uuid not null,
  stage text not null check (stage in ('script', 'images')),
  call_index integer not null check (call_index > 0),
  is_mock boolean not null,
  state text not null default 'dispatched'
    check (state in ('dispatched', 'succeeded', 'failed', 'unknown')),
  request_id text check (request_id is null or char_length(request_id) between 1 and 200),
  started_at timestamptz not null default pg_catalog.statement_timestamp(),
  finished_at timestamptz,
  foreign key (generation_id, owner_id) references public.generations(id, owner_id),
  unique (generation_id, stage, call_index),
  check ((stage = 'script' and call_index = 1)
    or (stage = 'images' and call_index between 1 and 4)),
  check ((state = 'dispatched' and finished_at is null)
    or (state <> 'dispatched' and finished_at is not null))
);
alter table private.provider_attempts enable row level security;
revoke all on private.provider_attempts from public, anon, authenticated, service_role;
grant select, insert on private.provider_attempts to service_role;
grant update (state, request_id, finished_at) on private.provider_attempts to service_role;
grant update (state) on private.reservations to service_role;

create function private.lock_generation_quota(p_generation_id uuid)
returns private.reservations
language plpgsql security invoker set search_path = ''
as $$
declare
  v_reservation private.reservations;
  v_counter private.quota_counters;
begin
  select * into v_reservation from private.reservations r
    where r.generation_id = p_generation_id;
  if not found then raise exception using message = 'RESERVATION_NOT_FOUND'; end if;

  perform pg_catalog.pg_advisory_xact_lock(20261103, 10001);

  select * into v_counter from private.quota_counters c
    where c.scope = 'global_total' and c.subject is null and c.day_key is null for update;
  if not found then raise exception using message = 'QUOTA_LEDGER_INCONSISTENT'; end if;
  select * into v_counter from private.quota_counters c
    where c.scope = 'global_day' and c.subject is null and c.day_key = v_reservation.reserved_day for update;
  if not found then raise exception using message = 'QUOTA_LEDGER_INCONSISTENT'; end if;
  select * into v_counter from private.quota_counters c
    where c.scope = 'user_day' and c.subject = v_reservation.owner_id
      and c.day_key = v_reservation.reserved_day for update;
  if not found then raise exception using message = 'QUOTA_LEDGER_INCONSISTENT'; end if;

  return v_reservation;
end;
$$;
revoke all on function private.lock_generation_quota(uuid) from public, anon, authenticated;
grant execute on function private.lock_generation_quota(uuid) to service_role;

create function public.claim_generation(p_generation_id uuid)
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
    'is_mock', v_generation.is_mock,
    'input_snapshot', v_generation.input_snapshot,
    'model_profile_snapshot', v_generation.model_profile_snapshot,
    'claim_token', v_claim_token,
    'deadline_at', v_deadline
  );
end;
$$;

create function public.begin_provider_attempt(
  p_generation_id uuid,
  p_claim_token uuid,
  p_stage text,
  p_call_index integer,
  p_generation_enabled boolean
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_policy private.generation_policy;
  v_attempt private.provider_attempts;
  v_last_call_index integer;
  v_max_image_calls integer := 1;
  v_now timestamptz;
begin
  if p_generation_id is null or p_claim_token is null
    or p_stage not in ('script', 'images') or p_stage is null
    or p_call_index is null or p_call_index <= 0
    or p_generation_enabled is null then
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
  if (p_stage = 'script' and v_generation.stage is distinct from 'script')
    or (p_stage = 'images' and v_generation.stage not in ('script', 'images')) then
    raise exception using message = 'STAGE_MISMATCH';
  end if;
  if v_generation.is_mock is null
    or not private.is_valid_generation_profile(v_generation.model_profile_snapshot)
    or v_generation.model_profile_snapshot = '{}'::jsonb
    or v_generation.model_profile_snapshot -> 'is_mock' is distinct from pg_catalog.to_jsonb(v_generation.is_mock) then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  if p_stage = 'script' and p_call_index <> 1 then
    raise exception using message = 'ATTEMPT_LIMIT_REACHED';
  end if;
  if p_stage = 'images' then
    v_max_image_calls := coalesce((v_generation.model_profile_snapshot ->> 'max_image_calls')::integer, 1);
    if p_call_index > v_max_image_calls then
      raise exception using message = 'ATTEMPT_LIMIT_REACHED';
    end if;
  end if;

  select * into v_policy from private.generation_policy p where p.id = 1;
  if not found or not v_policy.enabled then
    raise exception using message = 'GENERATION_DISABLED';
  end if;
  if not v_generation.is_mock and p_generation_enabled is distinct from true then
    raise exception using message = 'GENERATION_DISABLED';
  end if;

  if exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.state in ('dispatched', 'unknown')) then
    raise exception using message = 'ATTEMPT_UNRESOLVED';
  end if;
  if exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = p_stage and a.call_index = p_call_index) then
    raise exception using message = 'ATTEMPT_ALREADY_BEGUN';
  end if;
  if p_stage = 'script' and exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = 'script' and a.state = 'succeeded') then
    raise exception using message = 'ATTEMPT_STAGE_COMPLETE';
  end if;
  if p_stage = 'images' and not exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = 'script' and a.state = 'succeeded') then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;
  if p_stage = 'images' and v_generation.stage = 'script' then
    update public.generations set stage = 'images', updated_at = v_now
      where id = p_generation_id;
  end if;
  select pg_catalog.max(a.call_index) into v_last_call_index from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = p_stage;
  if p_stage = 'images' and coalesce(v_last_call_index, 0) > 0 and not exists (
    select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and a.stage = p_stage
      and a.call_index = v_last_call_index and a.state = 'succeeded'
  ) then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;
  if p_call_index <> coalesce(v_last_call_index, 0) + 1 then
    raise exception using message = 'ATTEMPT_ORDER_INVALID';
  end if;

  insert into private.provider_attempts (
    generation_id, owner_id, stage, call_index, is_mock, state, started_at
  ) values (
    v_generation.id, v_generation.owner_id, p_stage, p_call_index,
    v_generation.is_mock, 'dispatched', v_now
  ) returning * into v_attempt;

  return pg_catalog.jsonb_build_object(
    'attempt_id', v_attempt.id,
    'generation_id', v_attempt.generation_id,
    'stage', v_attempt.stage,
    'call_index', v_attempt.call_index,
    'mode', case when v_attempt.is_mock then 'mock' else 'provider' end,
    'is_mock', v_attempt.is_mock
  );
exception
  when unique_violation then raise exception using message = 'ATTEMPT_ALREADY_BEGUN';
end;
$$;

create function public.finish_provider_attempt(
  p_generation_id uuid,
  p_claim_token uuid,
  p_attempt_id uuid,
  p_state text,
  p_request_id text default null
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_reservation private.reservations;
  v_attempt private.provider_attempts;
  v_now timestamptz;
begin
  if p_generation_id is null or p_claim_token is null or p_attempt_id is null
    or p_state not in ('succeeded', 'failed', 'unknown') or p_state is null
    or (p_request_id is not null and char_length(p_request_id) not between 1 and 200) then
    raise exception using message = 'INVALID_INPUT';
  end if;

  select * into v_generation from public.generations g where g.id = p_generation_id;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  v_reservation := private.lock_generation_quota(p_generation_id);

  perform 1 from public.entries e
    where e.id = v_generation.entry_id and e.owner_id = v_generation.owner_id for update;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  select * into v_generation from public.generations g where g.id = p_generation_id for update;
  select * into v_reservation from private.reservations r
    where r.generation_id = p_generation_id for update;
  select * into v_attempt from private.provider_attempts a
    where a.id = p_attempt_id and a.generation_id = p_generation_id for update;
  if not found then raise exception using message = 'ATTEMPT_NOT_FOUND'; end if;
  v_now := pg_catalog.clock_timestamp();

  if v_generation.status <> 'running'
    or v_generation.claim_token is distinct from p_claim_token then
    raise exception using message = 'CLAIM_LOST';
  end if;
  if v_reservation.state <> 'reserved' then
    raise exception using message = 'GENERATION_TERMINAL';
  end if;
  if v_attempt.is_mock and p_request_id is not null then
    raise exception using message = 'INVALID_INPUT';
  end if;

  if v_attempt.state <> 'dispatched' then
    if v_attempt.state = p_state and v_attempt.request_id is not distinct from p_request_id then
      return pg_catalog.jsonb_build_object(
        'attempt_id', v_attempt.id,
        'state', v_attempt.state,
        'request_id', v_attempt.request_id,
        'finished_at', v_attempt.finished_at,
        'is_mock', v_attempt.is_mock
      );
    end if;
    raise exception using message = 'ATTEMPT_ALREADY_FINISHED';
  end if;

  update private.provider_attempts set state = p_state,
    request_id = p_request_id, finished_at = v_now
    where id = v_attempt.id and generation_id = p_generation_id and state = 'dispatched'
    returning * into v_attempt;
  return pg_catalog.jsonb_build_object(
    'attempt_id', v_attempt.id,
    'state', v_attempt.state,
    'request_id', v_attempt.request_id,
    'finished_at', v_attempt.finished_at,
    'is_mock', v_attempt.is_mock
  );
end;
$$;

create function public.fail_or_hold_generation(
  p_generation_id uuid,
  p_claim_token uuid,
  p_terminal_status text
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_unknown boolean;
  v_known boolean;
  v_terminal_status text;
  v_reservation_state text;
  v_updated integer;
  v_now timestamptz;
begin
  if p_generation_id is null or p_terminal_status not in ('failed', 'cancelled')
    or p_terminal_status is null then
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

  if v_generation.status not in ('queued', 'running') then
    return pg_catalog.jsonb_build_object(
      'generation_id', v_generation.id,
      'status', v_generation.status,
      'reservation_state', v_reservation.state,
      'released', false
    );
  end if;
  if v_generation.status = 'queued' then
    if p_claim_token is not null then raise exception using message = 'CLAIM_LOST'; end if;
  elsif p_claim_token is not null then
    if v_generation.claim_token is distinct from p_claim_token then
      raise exception using message = 'CLAIM_LOST';
    end if;
  elsif v_generation.deadline_at is null or v_generation.deadline_at > v_now then
    raise exception using message = 'CLAIM_REQUIRED';
  end if;
  if v_reservation.state <> 'reserved' then
    raise exception using message = 'QUOTA_LEDGER_INCONSISTENT';
  end if;

  select exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and not a.is_mock
      and a.state in ('dispatched', 'unknown')) into v_unknown;
  select exists (select 1 from private.provider_attempts a
    where a.generation_id = p_generation_id and not a.is_mock)
    or exists (select 1 from private.provider_attempts a
      where a.generation_id = p_generation_id and a.state in ('succeeded', 'failed'))
    into v_known;

  if v_unknown then
    v_terminal_status := 'unknown';
    v_reservation_state := 'held';
  elsif v_generation.cancel_requested or v_entry.deleted_at is not null
    or v_entry.expires_at <= v_now then
    v_terminal_status := 'cancelled';
    if v_known then
      v_reservation_state := 'consumed';
    else
      v_reservation_state := 'released';
    end if;
  else
    v_terminal_status := p_terminal_status;
    if v_known then
      v_reservation_state := 'consumed';
    else
      v_reservation_state := 'released';
    end if;
  end if;

  if v_reservation_state = 'released' then
    update private.quota_counters set count = count - 1,
      committed_micro_usd = committed_micro_usd - v_reservation.max_cost_micro_usd
      where scope = 'global_total' and subject is null and day_key is null
        and count > 0 and committed_micro_usd >= v_reservation.max_cost_micro_usd;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then raise exception using message = 'QUOTA_LEDGER_INCONSISTENT'; end if;
    update private.quota_counters set count = count - 1,
      committed_micro_usd = committed_micro_usd - v_reservation.max_cost_micro_usd
      where scope = 'global_day' and subject is null and day_key = v_reservation.reserved_day
        and count > 0 and committed_micro_usd >= v_reservation.max_cost_micro_usd;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then raise exception using message = 'QUOTA_LEDGER_INCONSISTENT'; end if;
    update private.quota_counters set count = count - 1,
      committed_micro_usd = committed_micro_usd - v_reservation.max_cost_micro_usd
      where scope = 'user_day' and subject = v_reservation.owner_id
        and day_key = v_reservation.reserved_day
        and count > 0 and committed_micro_usd >= v_reservation.max_cost_micro_usd;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then raise exception using message = 'QUOTA_LEDGER_INCONSISTENT'; end if;
  end if;

  update private.reservations set state = v_reservation_state
    where generation_id = p_generation_id and state = 'reserved';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then raise exception using message = 'QUOTA_LEDGER_INCONSISTENT'; end if;

  update public.generations set status = v_terminal_status, stage = null,
    error_code = case v_terminal_status
      when 'unknown' then 'RESULT_UNKNOWN'
      when 'cancelled' then 'CANCELLED'
      else 'GENERATION_FAILED'
    end,
    completed_at = v_now, updated_at = v_now
    where id = p_generation_id;

  return pg_catalog.jsonb_build_object(
    'generation_id', p_generation_id,
    'status', v_terminal_status,
    'reservation_state', v_reservation_state,
    'released', v_reservation_state = 'released'
  );
end;
$$;

revoke all on function public.claim_generation(uuid) from public, anon, authenticated;
revoke all on function public.begin_provider_attempt(uuid, uuid, text, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.finish_provider_attempt(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.fail_or_hold_generation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_generation(uuid) to service_role;
grant execute on function public.begin_provider_attempt(uuid, uuid, text, integer, boolean)
  to service_role;
grant execute on function public.finish_provider_attempt(uuid, uuid, uuid, text, text)
  to service_role;
grant execute on function public.fail_or_hold_generation(uuid, uuid, text)
  to service_role;

commit;
