begin;

alter table public.assets add column content_sha256 text
  check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$');
alter table public.assets add constraint assets_dimensions_bounded
  check (width <= 2048 and height <= 2048 and width::bigint * height::bigint <= 4194304);

create table private.comic_save_tasks (
  generation_id uuid primary key,
  owner_id uuid not null,
  entry_revision integer not null check (entry_revision > 0),
  diary_date date not null,
  provider_claim_token uuid not null,
  profile_id text not null,
  script jsonb not null,
  comic_draft jsonb not null,
  asset_metadata jsonb not null,
  save_claim_token uuid not null,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (generation_id, owner_id)
    references public.generations(id, owner_id) on delete cascade,
  check (pg_catalog.jsonb_typeof(asset_metadata) = 'array'
    and pg_catalog.jsonb_array_length(asset_metadata) = 4)
);
alter table private.comic_save_tasks enable row level security;
revoke all on private.comic_save_tasks from public, anon, authenticated, service_role;

create table private.storage_deletion_outbox (
  object_path text primary key
    check (object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'),
  next_check_at timestamptz not null,
  claim_token uuid,
  lease_expires_at timestamptz,
  attempt_count bigint not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_checked_at timestamptz,
  check ((claim_token is null) = (lease_expires_at is null))
);
create index storage_deletion_outbox_due_idx
  on private.storage_deletion_outbox (next_check_at, object_path);
alter table private.storage_deletion_outbox enable row level security;
revoke all on private.storage_deletion_outbox from public, anon, authenticated, service_role;

drop policy assets_read_own_live_entry on public.assets;
create policy assets_read_own_live_entry on public.assets for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1
    from public.generations g
    join public.entries e on e.id = g.entry_id and e.owner_id = g.owner_id
    where g.id = assets.generation_id and g.owner_id = assets.owner_id
      and g.status = 'succeeded'
      and e.deleted_at is null and e.expires_at > pg_catalog.statement_timestamp()
  ));

create function private.is_valid_comic_save_script(value jsonb)
returns boolean language plpgsql immutable strict security invoker set search_path = ''
as $$
declare
  v_panel jsonb;
  v_index integer := 0;
begin
  if pg_catalog.jsonb_typeof(value) is distinct from 'object'
    or (select count(*) from pg_catalog.jsonb_object_keys(value)) <> 2
    or pg_catalog.jsonb_typeof(value -> 'title') is distinct from 'string'
    or pg_catalog.char_length(value ->> 'title') not between 1 and 40
    or pg_catalog.jsonb_typeof(value -> 'panels') is distinct from 'array'
    or pg_catalog.jsonb_array_length(value -> 'panels') <> 4 then
    return false;
  end if;

  for v_panel in select p.value from pg_catalog.jsonb_array_elements(value -> 'panels') p(value)
  loop
    v_index := v_index + 1;
    if pg_catalog.jsonb_typeof(v_panel) is distinct from 'object'
      or (select count(*) from pg_catalog.jsonb_object_keys(v_panel)) <> 4
      or pg_catalog.jsonb_typeof(v_panel -> 'index') is distinct from 'number'
      or v_panel ->> 'index' !~ '^[1-4]$'
      or (v_panel ->> 'index')::integer <> v_index
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
revoke all on function private.is_valid_comic_save_script(jsonb)
  from public, anon, authenticated;
grant execute on function private.is_valid_comic_save_script(jsonb) to service_role;

create function private.comic_save_manifest(
  p_generation_id uuid,
  p_owner_id uuid,
  p_metadata jsonb
)
returns jsonb language plpgsql immutable security invoker set search_path = ''
as $$
declare
  v_item jsonb;
  v_index integer := 0;
  v_item_index integer;
  v_media_type text;
  v_byte_size integer;
  v_width integer;
  v_height integer;
  v_sha256 text;
  v_asset_id uuid;
  v_path text;
  v_total_size bigint := 0;
  v_total_pixels bigint := 0;
  v_manifest jsonb := '[]'::jsonb;
  v_digest text;
begin
  if p_generation_id is null or p_owner_id is null
    or pg_catalog.jsonb_typeof(p_metadata) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_metadata) <> 4 then
    raise exception using message = 'INVALID_ASSET_METADATA';
  end if;

  for v_item in select p.value from pg_catalog.jsonb_array_elements(p_metadata) p(value)
  loop
    v_index := v_index + 1;
    if pg_catalog.jsonb_typeof(v_item) is distinct from 'object'
      or (select count(*) from pg_catalog.jsonb_object_keys(v_item)) <> 6
      or pg_catalog.jsonb_typeof(v_item -> 'index') is distinct from 'number'
      or v_item ->> 'index' !~ '^[1-4]$'
      or pg_catalog.jsonb_typeof(v_item -> 'media_type') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item -> 'byte_size') is distinct from 'number'
      or v_item ->> 'byte_size' !~ '^[1-9][0-9]*$'
      or pg_catalog.jsonb_typeof(v_item -> 'width') is distinct from 'number'
      or v_item ->> 'width' !~ '^[1-9][0-9]*$'
      or pg_catalog.jsonb_typeof(v_item -> 'height') is distinct from 'number'
      or v_item ->> 'height' !~ '^[1-9][0-9]*$'
      or pg_catalog.jsonb_typeof(v_item -> 'sha256') is distinct from 'string'
      or v_item ->> 'sha256' !~ '^[a-f0-9]{64}$' then
      raise exception using message = 'INVALID_ASSET_METADATA';
    end if;

    v_item_index := (v_item ->> 'index')::integer;
    v_media_type := v_item ->> 'media_type';
    v_byte_size := (v_item ->> 'byte_size')::integer;
    v_width := (v_item ->> 'width')::integer;
    v_height := (v_item ->> 'height')::integer;
    v_sha256 := v_item ->> 'sha256';
    if v_item_index <> v_index
      or v_media_type not in ('image/png', 'image/jpeg', 'image/webp')
      or v_byte_size not between 1 and 8388608
      or v_width not between 1 and 2048
      or v_height not between 1 and 2048
      or v_width::bigint * v_height::bigint > 4194304 then
      raise exception using message = 'INVALID_ASSET_METADATA';
    end if;

    v_total_size := v_total_size + v_byte_size;
    v_total_pixels := v_total_pixels + v_width::bigint * v_height::bigint;
    v_digest := pg_catalog.md5(p_generation_id::text || ':comic-panel:' || v_index::text);
    v_asset_id := (pg_catalog.substr(v_digest, 1, 8) || '-' ||
      pg_catalog.substr(v_digest, 9, 4) || '-5' ||
      pg_catalog.substr(v_digest, 14, 3) || '-8' ||
      pg_catalog.substr(v_digest, 18, 3) || '-' ||
      pg_catalog.substr(v_digest, 21, 12))::uuid;
    v_path := p_owner_id::text || '/' || p_generation_id::text || '/' || v_asset_id::text ||
      case v_media_type when 'image/png' then '.png'
        when 'image/jpeg' then '.jpg' else '.webp' end;
    v_manifest := v_manifest || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'index', v_index,
      'asset_id', v_asset_id,
      'object_path', v_path,
      'media_type', v_media_type,
      'byte_size', v_byte_size,
      'width', v_width,
      'height', v_height,
      'sha256', v_sha256
    ));
  end loop;
  if v_total_size > 16777216 or v_total_pixels > 16777216 then
    raise exception using message = 'INVALID_ASSET_METADATA';
  end if;
  return v_manifest;
exception
  when numeric_value_out_of_range then
    raise exception using message = 'INVALID_ASSET_METADATA';
end;
$$;
revoke all on function private.comic_save_manifest(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function private.comic_save_manifest(uuid, uuid, jsonb) to service_role;

create function private.comic_save_attempts_complete(p_generation_id uuid)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select count(*) = 5 and count(*) filter (where not a.is_mock and a.state = 'succeeded'
    and ((a.stage = 'script' and a.call_index = 1)
      or (a.stage = 'images' and a.call_index between 1 and 4))) = 5
  from private.provider_attempts a where a.generation_id = p_generation_id;
$$;
revoke all on function private.comic_save_attempts_complete(uuid)
  from public, anon, authenticated;
grant execute on function private.comic_save_attempts_complete(uuid) to service_role;

create function private.settle_comic_save_locked(
  p_generation_id uuid,
  p_terminal_status text,
  p_now timestamptz
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_status text;
begin
  select * into v_generation from public.generations g where g.id = p_generation_id for update;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  select * into v_entry from public.entries e
    where e.id = v_generation.entry_id and e.owner_id = v_generation.owner_id;
  select * into v_reservation from private.reservations r
    where r.generation_id = p_generation_id and r.owner_id = v_generation.owner_id for update;

  if v_generation.status not in ('queued', 'running') then
    return pg_catalog.jsonb_build_object(
      'generation_id', v_generation.id, 'status', v_generation.status,
      'reservation_state', v_reservation.state, 'released', false
    );
  end if;
  if v_reservation.state <> 'reserved'
    or not private.comic_save_attempts_complete(p_generation_id) then
    raise exception using message = 'QUOTA_LEDGER_INCONSISTENT';
  end if;

  v_status := case
    when v_generation.cancel_requested or v_entry.id is null
      or v_entry.deleted_at is not null or v_entry.expires_at <= p_now then 'cancelled'
    else p_terminal_status
  end;
  update private.reservations set state = 'consumed'
    where generation_id = p_generation_id and owner_id = v_generation.owner_id and state = 'reserved';
  update public.generations set status = v_status, stage = null,
    error_code = case when v_status = 'cancelled' then 'CANCELLED' else 'SAVE_UNRECOVERABLE' end,
    completed_at = p_now, updated_at = p_now
    where id = p_generation_id;
  return pg_catalog.jsonb_build_object(
    'generation_id', p_generation_id, 'status', v_status,
    'reservation_state', 'consumed', 'released', false
  );
end;
$$;
revoke all on function private.settle_comic_save_locked(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

create function public.begin_comic_save_task(
  p_generation_id uuid,
  p_owner_id uuid,
  p_entry_revision integer,
  p_diary_date date,
  p_claim_token uuid,
  p_profile_id text,
  p_script jsonb,
  p_asset_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_task private.comic_save_tasks;
  v_manifest jsonb;
  v_comic_draft jsonb;
  v_now timestamptz;
  v_save_token uuid;
  v_result jsonb;
begin
  if p_generation_id is null or p_owner_id is null or p_entry_revision is null
    or p_entry_revision < 1 or p_diary_date is null or p_claim_token is null
    or p_profile_id is null or not private.is_valid_comic_save_script(p_script) then
    raise exception using message = 'INVALID_INPUT';
  end if;
  v_manifest := private.comic_save_manifest(p_generation_id, p_owner_id, p_asset_metadata);

  select * into v_generation from public.generations g where g.id = p_generation_id;
  if not found or v_generation.owner_id is distinct from p_owner_id then
    raise exception using message = 'NOT_FOUND';
  end if;
  v_reservation := private.lock_generation_quota(p_generation_id);
  select * into v_entry from public.entries e
    where e.id = v_generation.entry_id and e.owner_id = p_owner_id for update;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  select * into v_generation from public.generations g where g.id = p_generation_id for update;
  select * into v_reservation from private.reservations r
    where r.generation_id = p_generation_id for update;
  v_now := pg_catalog.clock_timestamp();

  if v_generation.status = 'succeeded' then
    return pg_catalog.jsonb_build_object(
      'status', 'succeeded', 'generation_id', p_generation_id,
      'comic_json', v_generation.comic_json
    );
  elsif v_generation.status in ('failed', 'cancelled', 'unknown') then
    return pg_catalog.jsonb_build_object(
      'status', v_generation.status, 'generation_id', p_generation_id
    );
  end if;
  if v_generation.status is distinct from 'running'
    or v_generation.stage is distinct from 'saving'
    or v_generation.claim_token is distinct from p_claim_token then
    raise exception using message = 'CLAIM_LOST';
  end if;
  if v_generation.owner_id is distinct from p_owner_id
    or v_generation.entry_revision is distinct from p_entry_revision
    or v_entry.revision is distinct from p_entry_revision
    or v_entry.diary_date is distinct from p_diary_date
    or v_generation.model_profile_snapshot ->> 'profile_id' is distinct from p_profile_id
    or v_generation.is_mock is distinct from false
    or private.is_valid_openai_generation_profile(v_generation.model_profile_snapshot) is not true then
    raise exception using message = 'GENERATION_SNAPSHOT_MISMATCH';
  end if;
  if v_reservation.owner_id is distinct from p_owner_id or v_reservation.state <> 'reserved'
    or v_reservation.max_cost_micro_usd is distinct from
      (v_generation.model_profile_snapshot ->> 'max_cost_micro_usd')::bigint then
    raise exception using message = 'QUOTA_LEDGER_INCONSISTENT';
  end if;
  if not private.comic_save_attempts_complete(p_generation_id) then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;
  if v_generation.cancel_requested or v_entry.deleted_at is not null
    or v_entry.expires_at <= v_now then
    return private.settle_comic_save_locked(p_generation_id, 'failed', v_now);
  end if;
  if v_generation.deadline_at is null or v_generation.deadline_at <= v_now then
    return pg_catalog.jsonb_build_object('status', 'pending', 'generation_id', p_generation_id);
  end if;

  v_comic_draft := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'title', p_script -> 'title',
    'panels', p_script -> 'panels',
    'visual', pg_catalog.jsonb_build_object(
      'kind', 'panels',
      'assetIds', (select pg_catalog.jsonb_agg(a.value -> 'asset_id' order by a.ordinality)
        from pg_catalog.jsonb_array_elements(v_manifest) with ordinality a(value, ordinality)),
      'textMode', 'external'
    )
  );

  select * into v_task from private.comic_save_tasks t
    where t.generation_id = p_generation_id for update;
  if found then
    if v_task.owner_id is distinct from p_owner_id
      or v_task.entry_revision is distinct from p_entry_revision
      or v_task.diary_date is distinct from p_diary_date
      or v_task.provider_claim_token is distinct from p_claim_token
      or v_task.profile_id is distinct from p_profile_id
      or v_task.script is distinct from p_script
      or v_task.comic_draft is distinct from v_comic_draft
      or v_task.asset_metadata is distinct from v_manifest then
      raise exception using message = 'SAVE_TASK_CONFLICT';
    end if;
    if v_task.lease_expires_at > v_now then
      return pg_catalog.jsonb_build_object('status', 'pending', 'generation_id', p_generation_id);
    end if;
    v_save_token := pg_catalog.gen_random_uuid();
    update private.comic_save_tasks set save_claim_token = v_save_token,
      lease_expires_at = least(v_now + interval '120 seconds',
        v_generation.deadline_at + interval '24 hours'), updated_at = v_now
      where generation_id = p_generation_id returning * into v_task;
  else
    v_save_token := pg_catalog.gen_random_uuid();
    insert into private.comic_save_tasks (
      generation_id, owner_id, entry_revision, diary_date, provider_claim_token,
      profile_id, script, comic_draft, asset_metadata, save_claim_token,
      lease_expires_at, created_at, updated_at
    ) values (
      p_generation_id, p_owner_id, p_entry_revision, p_diary_date, p_claim_token,
      p_profile_id, p_script, v_comic_draft, v_manifest, v_save_token,
      least(v_now + interval '120 seconds', v_generation.deadline_at + interval '24 hours'),
      v_now, v_now
    ) returning * into v_task;
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'generation_id', p_generation_id,
    'save_claim_token', v_task.save_claim_token,
    'lease_expires_at', v_task.lease_expires_at,
    'task', pg_catalog.jsonb_build_object(
      'owner_id', v_task.owner_id,
      'entry_id', v_generation.entry_id,
      'entry_revision', v_task.entry_revision,
      'diary_date', v_task.diary_date,
      'claim_token', v_task.provider_claim_token,
      'deadline_at', v_generation.deadline_at,
      'profile_id', v_task.profile_id,
      'script', v_task.script,
      'comic_draft', v_task.comic_draft,
      'asset_metadata', v_task.asset_metadata
    )
  );
end;
$$;
revoke all on function public.begin_comic_save_task(uuid, uuid, integer, date, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.begin_comic_save_task(uuid, uuid, integer, date, uuid, text, jsonb, jsonb)
  to service_role;

create function public.claim_comic_save_recovery(p_generation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_task private.comic_save_tasks;
  v_now timestamptz;
  v_result jsonb;
begin
  if p_generation_id is null then raise exception using message = 'INVALID_INPUT'; end if;
  select * into v_generation from public.generations g where g.id = p_generation_id;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'cancelled', 'generation_id', p_generation_id);
  end if;
  if v_generation.status = 'succeeded' then
    return pg_catalog.jsonb_build_object(
      'status', 'succeeded', 'generation_id', p_generation_id,
      'comic_json', v_generation.comic_json
    );
  elsif v_generation.status in ('failed', 'cancelled', 'unknown') then
    return pg_catalog.jsonb_build_object('status', v_generation.status, 'generation_id', p_generation_id);
  end if;

  v_reservation := private.lock_generation_quota(p_generation_id);
  select * into v_entry from public.entries e
    where e.id = v_generation.entry_id and e.owner_id = v_generation.owner_id for update;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  select * into v_generation from public.generations g where g.id = p_generation_id for update;
  select * into v_reservation from private.reservations r
    where r.generation_id = p_generation_id for update;
  select * into v_task from private.comic_save_tasks t
    where t.generation_id = p_generation_id for update;
  v_now := pg_catalog.clock_timestamp();

  if v_generation.status is distinct from 'running' or v_generation.stage is distinct from 'saving'
    or v_generation.is_mock is distinct from false
    or private.is_valid_openai_generation_profile(v_generation.model_profile_snapshot) is not true
    or v_generation.claim_token is null or v_generation.deadline_at is null
    or v_reservation.owner_id is distinct from v_generation.owner_id
    or v_reservation.state <> 'reserved'
    or not private.comic_save_attempts_complete(p_generation_id) then
    return private.settle_comic_save_locked(p_generation_id, 'failed', v_now);
  end if;
  if v_generation.deadline_at > v_now then
    return pg_catalog.jsonb_build_object('status', 'pending', 'generation_id', p_generation_id);
  end if;
  if v_generation.deadline_at + interval '24 hours' <= v_now then
    return private.settle_comic_save_locked(p_generation_id, 'failed', v_now);
  end if;
  if v_generation.cancel_requested or v_entry.deleted_at is not null
    or v_entry.expires_at <= v_now then
    return private.settle_comic_save_locked(p_generation_id, 'cancelled', v_now);
  end if;
  if not found then
    return private.settle_comic_save_locked(p_generation_id, 'failed', v_now);
  end if;
  if v_task.owner_id is distinct from v_generation.owner_id
    or v_task.provider_claim_token is distinct from v_generation.claim_token
    or v_task.entry_revision is distinct from v_generation.entry_revision
    or v_task.diary_date is distinct from v_entry.diary_date
    or v_task.profile_id is distinct from v_generation.model_profile_snapshot ->> 'profile_id' then
    return private.settle_comic_save_locked(p_generation_id, 'failed', v_now);
  end if;
  if v_task.lease_expires_at > v_now then
    return pg_catalog.jsonb_build_object('status', 'pending', 'generation_id', p_generation_id);
  end if;

  update private.comic_save_tasks set save_claim_token = pg_catalog.gen_random_uuid(),
    lease_expires_at = least(v_now + interval '120 seconds',
      v_generation.deadline_at + interval '24 hours'), updated_at = v_now
    where generation_id = p_generation_id returning * into v_task;
  return pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'generation_id', p_generation_id,
    'save_claim_token', v_task.save_claim_token,
    'lease_expires_at', v_task.lease_expires_at,
    'task', pg_catalog.jsonb_build_object(
      'owner_id', v_task.owner_id,
      'entry_id', v_generation.entry_id,
      'entry_revision', v_task.entry_revision,
      'diary_date', v_task.diary_date,
      'claim_token', v_task.provider_claim_token,
      'deadline_at', v_generation.deadline_at,
      'profile_id', v_task.profile_id,
      'script', v_task.script,
      'comic_draft', v_task.comic_draft,
      'asset_metadata', v_task.asset_metadata
    )
  );
end;
$$;
revoke all on function public.claim_comic_save_recovery(uuid) from public, anon, authenticated;
grant execute on function public.claim_comic_save_recovery(uuid) to service_role;

create function public.complete_comic_save(
  p_generation_id uuid,
  p_owner_id uuid,
  p_entry_revision integer,
  p_diary_date date,
  p_claim_token uuid,
  p_save_claim_token uuid,
  p_profile_id text,
  p_comic_json jsonb,
  p_asset_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_task private.comic_save_tasks;
  v_manifest jsonb;
  v_actual_assets jsonb;
  v_now timestamptz;
begin
  if p_generation_id is null or p_owner_id is null or p_entry_revision is null
    or p_diary_date is null or p_claim_token is null or p_save_claim_token is null
    or p_profile_id is null or pg_catalog.jsonb_typeof(p_comic_json) is distinct from 'object' then
    raise exception using message = 'INVALID_INPUT';
  end if;
  v_manifest := private.comic_save_manifest(p_generation_id, p_owner_id, p_asset_metadata);
  select * into v_generation from public.generations g where g.id = p_generation_id;
  if not found or v_generation.owner_id is distinct from p_owner_id then
    raise exception using message = 'NOT_FOUND';
  end if;
  v_reservation := private.lock_generation_quota(p_generation_id);
  select * into v_entry from public.entries e
    where e.id = v_generation.entry_id and e.owner_id = p_owner_id for update;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  select * into v_generation from public.generations g where g.id = p_generation_id for update;
  select * into v_reservation from private.reservations r
    where r.generation_id = p_generation_id for update;
  select * into v_task from private.comic_save_tasks t
    where t.generation_id = p_generation_id for update;
  v_now := pg_catalog.clock_timestamp();

  if v_generation.claim_token is distinct from p_claim_token
    or v_generation.owner_id is distinct from p_owner_id then
    raise exception using message = 'CLAIM_LOST';
  end if;

  if v_generation.status = 'succeeded' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'index', item.ordinality,
      'asset_id', asset.id,
      'object_path', asset.object_path,
      'media_type', asset.media_type,
      'byte_size', asset.byte_size,
      'width', asset.width,
      'height', asset.height,
      'sha256', asset.content_sha256
    ) order by item.ordinality), '[]'::jsonb)
    into v_actual_assets
    from pg_catalog.jsonb_array_elements_text(v_generation.comic_json #> '{visual,assetIds}')
      with ordinality item(asset_id, ordinality)
    join public.assets asset on asset.id = item.asset_id::uuid
      and asset.generation_id = p_generation_id and asset.owner_id = p_owner_id;
    if v_generation.comic_json is distinct from p_comic_json
      or v_actual_assets is distinct from v_manifest then
      raise exception using message = 'SAVE_TASK_CONFLICT';
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'succeeded', 'generation_id', p_generation_id,
      'comic_json', v_generation.comic_json,
      'asset_ids', v_generation.comic_json #> '{visual,assetIds}'
    );
  elsif v_generation.status in ('failed', 'cancelled', 'unknown') then
    return pg_catalog.jsonb_build_object('status', v_generation.status, 'generation_id', p_generation_id);
  end if;

  if v_generation.status is distinct from 'running' or v_generation.stage is distinct from 'saving'
    or v_task.generation_id is null then
    return private.settle_comic_save_locked(p_generation_id, 'failed', v_now);
  end if;
  if v_generation.entry_revision is distinct from p_entry_revision
    or v_entry.revision is distinct from p_entry_revision
    or v_entry.diary_date is distinct from p_diary_date
    or v_task.owner_id is distinct from p_owner_id
    or v_task.entry_revision is distinct from p_entry_revision
    or v_task.diary_date is distinct from p_diary_date
    or v_task.provider_claim_token is distinct from p_claim_token
    or v_task.profile_id is distinct from p_profile_id
    or v_generation.model_profile_snapshot ->> 'profile_id' is distinct from p_profile_id
    or v_generation.is_mock is distinct from false
    or private.is_valid_openai_generation_profile(v_generation.model_profile_snapshot) is not true then
    raise exception using message = 'GENERATION_SNAPSHOT_MISMATCH';
  end if;
  if v_generation.cancel_requested or v_entry.deleted_at is not null
    or v_entry.expires_at <= v_now then
    return private.settle_comic_save_locked(p_generation_id, 'cancelled', v_now);
  end if;
  if v_generation.deadline_at is null
    or v_generation.deadline_at + interval '24 hours' <= v_now then
    return private.settle_comic_save_locked(p_generation_id, 'failed', v_now);
  end if;
  if v_reservation.owner_id is distinct from p_owner_id or v_reservation.state <> 'reserved'
    or v_reservation.max_cost_micro_usd is distinct from
      (v_generation.model_profile_snapshot ->> 'max_cost_micro_usd')::bigint then
    raise exception using message = 'QUOTA_LEDGER_INCONSISTENT';
  end if;
  if not private.comic_save_attempts_complete(p_generation_id) then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;
  if v_task.save_claim_token is distinct from p_save_claim_token
    or v_task.lease_expires_at <= v_now then
    return pg_catalog.jsonb_build_object('status', 'pending', 'generation_id', p_generation_id);
  end if;
  if v_task.asset_metadata is distinct from v_manifest
    or v_task.comic_draft is distinct from p_comic_json then
    raise exception using message = 'COMIC_ASSET_MISMATCH';
  end if;

  insert into public.assets (
    id, generation_id, owner_id, object_path, media_type, byte_size, width, height, content_sha256
  )
  select (asset.value ->> 'asset_id')::uuid, p_generation_id, p_owner_id,
    asset.value ->> 'object_path', asset.value ->> 'media_type',
    (asset.value ->> 'byte_size')::integer, (asset.value ->> 'width')::integer,
    (asset.value ->> 'height')::integer, asset.value ->> 'sha256'
  from pg_catalog.jsonb_array_elements(v_manifest) asset(value);

  update public.generations set status = 'succeeded', stage = null, comic_json = p_comic_json,
    error_code = null, completed_at = v_now, updated_at = v_now
    where id = p_generation_id;
  update private.reservations set state = 'consumed'
    where generation_id = p_generation_id and owner_id = p_owner_id and state = 'reserved';
  delete from private.comic_save_tasks where generation_id = p_generation_id;

  return pg_catalog.jsonb_build_object(
    'status', 'succeeded', 'generation_id', p_generation_id,
    'comic_json', p_comic_json,
    'asset_ids', p_comic_json #> '{visual,assetIds}'
  );
end;
$$;
revoke all on function public.complete_comic_save(uuid, uuid, integer, date, uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_comic_save(uuid, uuid, integer, date, uuid, uuid, text, jsonb, jsonb)
  to service_role;

create function public.fail_comic_save(
  p_generation_id uuid,
  p_claim_token uuid,
  p_save_claim_token uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_generation public.generations;
  v_entry public.entries;
  v_reservation private.reservations;
  v_task private.comic_save_tasks;
  v_now timestamptz;
begin
  if p_generation_id is null or p_claim_token is null or p_save_claim_token is null then
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
  select * into v_task from private.comic_save_tasks t
    where t.generation_id = p_generation_id for update;
  v_now := pg_catalog.clock_timestamp();

  if v_generation.status in ('failed', 'cancelled', 'unknown', 'succeeded') then
    return pg_catalog.jsonb_build_object(
      'status', v_generation.status, 'generation_id', p_generation_id,
      'reservation_state', v_reservation.state, 'released', false
    );
  end if;
  if v_generation.status is distinct from 'running' or v_generation.stage is distinct from 'saving'
    or v_generation.claim_token is distinct from p_claim_token
    or v_task.generation_id is null
    or v_task.provider_claim_token is distinct from p_claim_token then
    raise exception using message = 'CLAIM_LOST';
  end if;
  if v_task.save_claim_token is distinct from p_save_claim_token
    or v_task.lease_expires_at <= v_now then
    return pg_catalog.jsonb_build_object('status', 'pending', 'generation_id', p_generation_id);
  end if;
  if v_reservation.owner_id is distinct from v_generation.owner_id
    or v_reservation.state <> 'reserved' then
    raise exception using message = 'QUOTA_LEDGER_INCONSISTENT';
  end if;
  if not private.comic_save_attempts_complete(p_generation_id) then
    raise exception using message = 'ATTEMPT_STAGE_INCOMPLETE';
  end if;
  return private.settle_comic_save_locked(p_generation_id, 'failed', v_now);
end;
$$;
revoke all on function public.fail_comic_save(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fail_comic_save(uuid, uuid, uuid) to service_role;

create or replace function public.claim_retention_cleanup(p_limit integer default 10)
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
      and not exists (
        select 1 from private.comic_save_tasks task
        join public.generations g on g.id = task.generation_id and g.owner_id = task.owner_id
        where g.entry_id = e.id and g.owner_id = e.owner_id
          and task.lease_expires_at > v_now
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
        select pg_catalog.array_agg(paths.object_path order by paths.object_path)
        from (
          select distinct a.object_path
          from public.assets a
          join public.generations g on g.id = a.generation_id and g.owner_id = a.owner_id
          where g.entry_id = c.id and g.owner_id = c.owner_id
          union
          select task_asset.value ->> 'object_path'
          from private.comic_save_tasks task
          join public.generations g on g.id = task.generation_id and g.owner_id = task.owner_id
          cross join lateral pg_catalog.jsonb_array_elements(task.asset_metadata) task_asset(value)
          where g.entry_id = c.id and g.owner_id = c.owner_id
        ) paths
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

create or replace function public.finalize_retention_cleanup(
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
  if exists (
    select 1 from private.comic_save_tasks task
    join public.generations g on g.id = task.generation_id and g.owner_id = task.owner_id
    where g.entry_id = p_entry_id and g.owner_id = v_owner_id
      and task.lease_expires_at > v_now
  ) then return false; end if;

  select coalesce(pg_catalog.array_agg(paths.object_path order by paths.object_path), '{}'::text[])
    into v_object_paths
  from (
    select distinct a.object_path
    from public.assets a
    join public.generations g on g.id = a.generation_id and g.owner_id = a.owner_id
    where g.entry_id = p_entry_id and g.owner_id = v_owner_id
    union
    select task_asset.value ->> 'object_path'
    from private.comic_save_tasks task
    join public.generations g on g.id = task.generation_id and g.owner_id = task.owner_id
    cross join lateral pg_catalog.jsonb_array_elements(task.asset_metadata) task_asset(value)
    where g.entry_id = p_entry_id and g.owner_id = v_owner_id
  ) paths;
  if v_object_paths is distinct from v_lease.object_paths then return false; end if;

  insert into private.storage_deletion_outbox (object_path, next_check_at)
  select path.object_path, v_now + interval '1 hour'
  from pg_catalog.unnest(v_object_paths) path(object_path)
  on conflict (object_path) do nothing;

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
  delete from private.comic_save_tasks task
    using public.generations g
    where task.generation_id = g.id and task.owner_id = g.owner_id
      and g.entry_id = p_entry_id and g.owner_id = v_owner_id;
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

create function public.claim_storage_deletion_cleanup(p_limit integer default 40)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_tasks jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 40 then
    raise exception using message = 'INVALID_LIMIT';
  end if;

  with candidates as materialized (
    select outbox.object_path
    from private.storage_deletion_outbox outbox
    where outbox.next_check_at <= v_now
      and (outbox.claim_token is null or outbox.lease_expires_at <= v_now)
    order by outbox.next_check_at, outbox.object_path
    limit p_limit
    for update of outbox skip locked
  ), claimed as (
    update private.storage_deletion_outbox outbox
    set claim_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = v_now + interval '15 minutes',
        attempt_count = outbox.attempt_count + 1
    from candidates
    where outbox.object_path = candidates.object_path
    returning outbox.object_path, outbox.claim_token, outbox.lease_expires_at
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'object_path', claimed.object_path,
      'claim_token', claimed.claim_token,
      'lease_expires_at', claimed.lease_expires_at
    ) order by claimed.object_path), '[]'::jsonb)
    into v_tasks
  from claimed;

  return v_tasks;
end;
$$;

create function public.finalize_storage_deletion_cleanup(
  p_object_path text,
  p_claim_token uuid,
  p_storage_absent boolean
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_outbox private.storage_deletion_outbox;
  v_now timestamptz;
begin
  if p_object_path is null or p_claim_token is null or p_storage_absent is distinct from true then
    return false;
  end if;

  select * into v_outbox
  from private.storage_deletion_outbox outbox
  where outbox.object_path = p_object_path
  for update;
  if not found then return false; end if;

  v_now := pg_catalog.clock_timestamp();
  if v_outbox.claim_token <> p_claim_token or v_outbox.lease_expires_at <= v_now then
    return false;
  end if;

  update private.storage_deletion_outbox
  set next_check_at = v_now + interval '1 day',
      claim_token = null,
      lease_expires_at = null,
      last_checked_at = v_now
  where object_path = p_object_path;
  return true;
end;
$$;

revoke all on function public.claim_storage_deletion_cleanup(integer)
  from public, anon, authenticated;
revoke all on function public.finalize_storage_deletion_cleanup(text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_storage_deletion_cleanup(integer) to service_role;
grant execute on function public.finalize_storage_deletion_cleanup(text, uuid, boolean)
  to service_role;

commit;
