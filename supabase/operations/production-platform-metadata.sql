BEGIN READ ONLY;
SET LOCAL default_transaction_read_only=on;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog;
WITH relations AS (
  SELECT c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='storage' AND c.relname IN ('buckets', 'objects')
), delegation AS (
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM pg_catalog.pg_settings
    WHERE name='supautils.policy_grants' AND context='sighup' AND vartype='string'
  ) THEN COALESCE(
    pg_catalog.current_setting('supautils.policy_grants',true)::jsonb -> 'postgres'
      @> '["storage.buckets","storage.objects"]'::jsonb,false)
  ELSE false END AS granted
), policies AS (
  SELECT p.*, r.relname,
    pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'[[:space:]()]','','g') AS qual,
    pg_catalog.regexp_replace(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'[[:space:]()]','','g') AS check_expr
  FROM pg_catalog.pg_policy p JOIN relations r ON r.oid=p.polrelid
), expected AS (
  SELECT * FROM (VALUES
    ('buckets','comics_deny_direct_bucket_access','id<>''comics''::text'),
    ('objects','comics_deny_direct_user_access','bucket_id<>''comics''::text')
  ) AS values_table(table_name,policy_name,expression)
)
SELECT pg_catalog.json_build_object(
  'identityOk',current_user='postgres' AND pg_catalog.current_database()='postgres',
  'readOnly',pg_catalog.current_setting('transaction_read_only')='on',
  'storageRlsOk',(SELECT count(*)=2 AND bool_and(relrowsecurity AND NOT relforcerowsecurity) FROM relations),
  'storagePolicyDelegated',current_user='postgres' AND (SELECT granted FROM delegation),
  'storageOwnerPrivilege',(SELECT count(*)=2 AND bool_and(pg_catalog.pg_has_role(current_user,relowner,'USAGE')) FROM relations),
  'storageOwnerSetPrivilege',(SELECT count(*)=2 AND bool_and(pg_catalog.pg_has_role(current_user,relowner,'SET')) FROM relations),
  'sameStorageOwner',(SELECT count(*)=2 AND count(DISTINCT relowner)=1 FROM relations),
  'missingPolicyCount',(SELECT count(*) FROM expected e LEFT JOIN policies p ON p.relname=e.table_name AND p.polname=e.policy_name WHERE p.oid IS NULL),
  'mismatchedPolicyCount',(
    SELECT count(*) FROM expected e JOIN policies p ON p.relname=e.table_name AND p.polname=e.policy_name
    WHERE NOT COALESCE(NOT p.polpermissive AND p.polcmd='*' AND p.qual=e.expression AND p.check_expr=e.expression
      AND p.polroles @> ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='anon'),(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated')]::oid[],false)
  ),
  'restrictivePoliciesOk',(
    SELECT count(*)=2 AND bool_and(COALESCE(
      NOT p.polpermissive AND p.polcmd='*' AND p.qual=e.expression AND p.check_expr=e.expression
      AND p.polroles @> ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='anon'),(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated')]::oid[]
    ,false)) FROM expected e LEFT JOIN policies p ON p.relname=e.table_name AND p.polname=e.policy_name
  ),
  'serviceRoleBypassRls',(SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='service_role'),
  'anonBypassRls',(SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='anon'),
  'authenticatedBypassRls',(SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='authenticated'),
  'serviceRoleCanSelectObjects',pg_catalog.has_table_privilege('service_role','storage.objects','SELECT'),
  'serviceRoleCanInsertObjects',pg_catalog.has_table_privilege('service_role','storage.objects','INSERT'),
  'serviceRoleCanDeleteObjects',pg_catalog.has_table_privilege('service_role','storage.objects','DELETE')
)::text;
ROLLBACK;
