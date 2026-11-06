-- supautils.policy_grantsを固定2tableに設定した、廃棄する専用Supabase PostgreSQLだけで実行する。
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF pg_catalog.to_regnamespace('storage') IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_settings
      WHERE name='supautils.policy_grants' AND context='sighup' AND vartype='string')
    OR NOT COALESCE(pg_catalog.current_setting('supautils.policy_grants',true)::jsonb -> 'postgres'
      @> '["storage.buckets","storage.objects"]'::jsonb,false) THEN
    RAISE EXCEPTION 'ISOLATED_SUPAUTILS_PLATFORM_TEST_REQUIRED';
  END IF;
END $$;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE ROLE storage_owner;
CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA storage TO postgres;
CREATE TABLE storage.buckets(id text);
CREATE TABLE storage.objects(bucket_id text);
ALTER TABLE storage.buckets OWNER TO storage_owner;
ALTER TABLE storage.objects OWNER TO storage_owner;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects,storage.buckets TO postgres;
GRANT SELECT,INSERT,DELETE ON storage.objects TO service_role;
ALTER ROLE postgres NOSUPERUSER;
\connect postgres postgres
DO $$ BEGIN
  IF pg_catalog.current_setting('is_superuser') <> 'off'
    OR pg_catalog.pg_has_role(current_user,'storage_owner','USAGE')
    OR pg_catalog.pg_has_role(current_user,'storage_owner','SET') THEN
    RAISE EXCEPTION 'NO_OWNER_MEMBERSHIP_TEST_REQUIRED';
  END IF;
END $$;
\ir ../operations/production-platform-policies.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_policy WHERE polname IN ('comics_deny_direct_bucket_access','comics_deny_direct_user_access') AND NOT polpermissive) <> 2 THEN
    RAISE EXCEPTION 'DELEGATED_POLICIES_NOT_CREATED';
  END IF;
END $$;
CREATE TEMP TABLE original_policy_oids AS SELECT oid,polname FROM pg_catalog.pg_policy;
\ir ../operations/production-platform-policies.sql
DO $$ BEGIN
  IF EXISTS (SELECT oid,polname FROM original_policy_oids EXCEPT SELECT oid,polname FROM pg_catalog.pg_policy) THEN
    RAISE EXCEPTION 'VALID_POLICY_WAS_REPLACED';
  END IF;
END $$;
DROP POLICY comics_deny_direct_bucket_access ON storage.buckets;
DROP POLICY comics_deny_direct_user_access ON storage.objects;
CREATE POLICY comics_deny_direct_user_access ON storage.objects AS PERMISSIVE FOR ALL TO anon,authenticated USING (true) WITH CHECK (true);
\set ON_ERROR_STOP off
\ir ../operations/production-platform-policies.sql
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname='comics_deny_direct_bucket_access')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname='comics_deny_direct_user_access' AND polpermissive) THEN
    RAISE EXCEPTION 'DELEGATED_MISMATCH_NOT_ROLLED_BACK';
  END IF;
  IF (SELECT count(*) <> 2 OR NOT bool_and(relrowsecurity) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='storage' AND c.relname IN ('buckets','objects')) THEN
    RAISE EXCEPTION 'RLS_WAS_CHANGED';
  END IF;
END $$;
\echo STORAGE_POLICY_DELEGATION_FIXTURE_PASSED
