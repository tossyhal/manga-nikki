begin;

create table private.comic_shares (
  generation_id uuid primary key references public.generations(id) on delete cascade,
  token text not null unique check (token ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table private.comic_shares enable row level security;
revoke all on private.comic_shares from public, anon, authenticated, service_role;

create function public.create_comic_share(p_actor_id uuid, p_generation_id uuid, p_token text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if p_actor_id is null or p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    raise exception using message = 'INVALID_INPUT';
  end if;
  perform 1 from public.generations g
    join public.entries e on e.id = g.entry_id and e.owner_id = g.owner_id
    where g.id = p_generation_id and g.owner_id = p_actor_id
      and g.status = 'succeeded' and g.comic_json is not null
      and e.deleted_at is null and e.expires_at > pg_catalog.statement_timestamp()
    for share of e, g;
  if not found then raise exception using message = 'NOT_FOUND'; end if;
  insert into private.comic_shares(generation_id, token) values(p_generation_id, p_token)
    on conflict(generation_id) do update set generation_id = excluded.generation_id
    returning token into v_token;
  return v_token;
end;
$$;

create function public.read_comic_share(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'comic', g.comic_json,
    'is_mock', g.is_mock,
    'assets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', a.id, 'object_path', a.object_path, 'media_type', a.media_type,
      'owner_id', a.owner_id, 'generation_id', a.generation_id
    ) order by a.id) from public.assets a where a.generation_id = g.id and a.owner_id = g.owner_id), '[]'::jsonb)
  )
  from private.comic_shares s
  join public.generations g on g.id = s.generation_id
  join public.entries e on e.id = g.entry_id and e.owner_id = g.owner_id
  where s.token = p_token and p_token ~ '^[a-f0-9]{64}$'
    and g.status = 'succeeded' and e.deleted_at is null
    and e.expires_at > pg_catalog.statement_timestamp();
$$;
revoke all on function public.create_comic_share(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.read_comic_share(text) from public, anon, authenticated;
grant execute on function public.create_comic_share(uuid, uuid, text) to service_role;
grant execute on function public.read_comic_share(text) to service_role;

commit;
