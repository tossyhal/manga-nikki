-- Storage schemaが存在しない、廃棄する専用PostgreSQLクラスタだけで実行する。
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF pg_catalog.to_regnamespace('storage') IS NOT NULL THEN
    RAISE EXCEPTION 'EMPTY_ISOLATED_PLATFORM_TEST_DATABASE_REQUIRED';
  END IF;
END $$;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE ROLE storage_owner;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text);
CREATE TABLE storage.objects(bucket_id text);
ALTER TABLE storage.buckets OWNER TO storage_owner;
ALTER TABLE storage.objects OWNER TO storage_owner;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,DELETE ON storage.objects TO service_role;

-- 不足2件。
\ir ../operations/production-platform-policies.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_policy WHERE polname IN ('comics_deny_direct_bucket_access','comics_deny_direct_user_access')) <> 2 THEN
    RAISE EXCEPTION 'MISSING_POLICIES_NOT_CREATED';
  END IF;
END $$;
CREATE TEMP TABLE original_policy_oids AS SELECT oid,polname FROM pg_catalog.pg_policy;

-- 正しい既存policyはOIDも変えない。
\ir ../operations/production-platform-policies.sql
DO $$ BEGIN
  IF EXISTS (SELECT oid,polname FROM original_policy_oids EXCEPT SELECT oid,polname FROM pg_catalog.pg_policy) THEN
    RAISE EXCEPTION 'VALID_POLICY_WAS_REPLACED';
  END IF;
END $$;

-- 不足1件だけ作成し、他方は保持する。
DROP POLICY comics_deny_direct_user_access ON storage.objects;
\ir ../operations/production-platform-policies.sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN original_policy_oids o USING (oid,polname) WHERE p.polname='comics_deny_direct_bucket_access') THEN
    RAISE EXCEPTION 'EXISTING_BUCKET_POLICY_WAS_REPLACED';
  END IF;
END $$;

-- 後半で不一致を検知したとき、先に作ったpolicyもrollbackする。
DROP POLICY comics_deny_direct_bucket_access ON storage.buckets;
DROP POLICY comics_deny_direct_user_access ON storage.objects;
CREATE POLICY comics_deny_direct_user_access ON storage.objects AS PERMISSIVE FOR ALL TO anon,authenticated USING (true) WITH CHECK (true);
\set ON_ERROR_STOP off
\ir ../operations/production-platform-policies.sql
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname='comics_deny_direct_bucket_access')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polname='comics_deny_direct_user_access' AND polpermissive) THEN
    RAISE EXCEPTION 'MISMATCH_NOT_ROLLED_BACK';
  END IF;
END $$;
\echo STORAGE_POLICY_FIXTURE_FOUR_CASES_PASSED
