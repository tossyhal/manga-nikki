begin;

-- Existing jobs without a recorded source remain unknown rather than being presented as real output.
alter table public.generations add column is_mock boolean;
revoke all (is_mock) on table public.generations from public, anon, authenticated;
grant select (is_mock) on table public.generations to authenticated;

commit;
