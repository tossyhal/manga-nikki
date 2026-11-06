BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
DO $$
DECLARE
  owner_oid oid;
  relation_count integer;
  owner_count integer;
  expected record;
  actual record;
BEGIN
  IF pg_catalog.current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'STORAGE_IDENTITY_INVALID';
  END IF;
  SELECT count(*),count(DISTINCT c.relowner),min(c.relowner::bigint)::oid
    INTO relation_count,owner_count,owner_oid
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='storage' AND c.relname IN ('buckets','objects') AND c.relkind='r';
  IF relation_count <> 2 OR owner_count <> 1 THEN
    RAISE EXCEPTION 'STORAGE_POLICY_OWNER_ACTION_REQUIRED';
  END IF;
  IF current_user <> 'postgres' AND current_user <> pg_catalog.pg_get_userbyid(owner_oid) THEN
    RAISE EXCEPTION 'STORAGE_IDENTITY_INVALID';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user,owner_oid,'USAGE') THEN
    IF NOT pg_catalog.pg_has_role(current_user,owner_oid,'SET') THEN
      RAISE EXCEPTION 'STORAGE_POLICY_OWNER_ACTION_REQUIRED';
    END IF;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I',pg_catalog.pg_get_userbyid(owner_oid));
  END IF;
  LOCK TABLE storage.buckets,storage.objects IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT count(*) <> 2 OR NOT bool_and(c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relowner=owner_oid)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='storage' AND c.relname IN ('buckets','objects'))
    OR NOT COALESCE((SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='service_role'),false)
    OR COALESCE((SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='anon'),true)
    OR COALESCE((SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='authenticated'),true)
    OR NOT pg_catalog.has_table_privilege('service_role','storage.objects','SELECT')
    OR NOT pg_catalog.has_table_privilege('service_role','storage.objects','INSERT')
    OR NOT pg_catalog.has_table_privilege('service_role','storage.objects','DELETE') THEN
    RAISE EXCEPTION 'STORAGE_PLATFORM_INVALID';
  END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('storage.buckets'::regclass,'comics_deny_direct_bucket_access','id<>''comics''::text',
     'CREATE POLICY comics_deny_direct_bucket_access ON storage.buckets AS RESTRICTIVE FOR ALL TO anon,authenticated USING (id <> ''comics'') WITH CHECK (id <> ''comics'')'),
    ('storage.objects'::regclass,'comics_deny_direct_user_access','bucket_id<>''comics''::text',
     'CREATE POLICY comics_deny_direct_user_access ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated USING (bucket_id <> ''comics'') WITH CHECK (bucket_id <> ''comics'')')
  ) AS fixed_policies(relation_id,policy_name,expression,create_sql) LOOP
    SELECT * INTO actual FROM pg_catalog.pg_policy
      WHERE polrelid=expected.relation_id AND polname=expected.policy_name;
    IF NOT FOUND THEN
      EXECUTE expected.create_sql;
      SELECT * INTO STRICT actual FROM pg_catalog.pg_policy
        WHERE polrelid=expected.relation_id AND polname=expected.policy_name;
    END IF;
    IF NOT COALESCE(
      NOT actual.polpermissive AND actual.polcmd='*'
      AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(actual.polqual,actual.polrelid),'[[:space:]()]','','g')=expected.expression
      AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(actual.polwithcheck,actual.polrelid),'[[:space:]()]','','g')=expected.expression
      AND actual.polroles @> ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='anon'),(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated')]::oid[]
    ,false) THEN
      RAISE EXCEPTION 'STORAGE_POLICY_MISMATCH';
    END IF;
  END LOOP;
END;
$$;
COMMIT;
SELECT 'STORAGE_POLICY_TRANSACTION_COMMITTED';
