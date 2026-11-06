import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DEV_DATABASE_HOST,
  DEV_DATABASE_PORT,
  DEV_DATABASE_NAME,
  DEV_DATABASE_USER,
  DEV_DATABASE_ROOT_CERTIFICATE_PATH,
  verifyPinnedRootCertificate,
} from './dev-database-preflight.ts';
import { createPsqlEnvironment, DEV_DATABASE_PSQL_PATH } from './dev-database-preflight-runner.ts';
import { ProductionPlatformMetadataFailure } from './production-platform-metadata.ts';

const execute = promisify(execFile);
export const POLICY_SQL_PATH = fileURLToPath(
  new URL('../../supabase/operations/production-platform-policies.sql', import.meta.url),
);
export async function applyProductionStoragePolicies(
  password: string,
  executor: typeof execute = execute,
): Promise<void> {
  if (!password) throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_QUERY_FAILED');
  await verifyPinnedRootCertificate(DEV_DATABASE_ROOT_CERTIFICATE_PATH, new Date());
  const env = createPsqlEnvironment({
    host: DEV_DATABASE_HOST,
    port: DEV_DATABASE_PORT,
    database: DEV_DATABASE_NAME,
    user: DEV_DATABASE_USER,
    password,
    sslRootCert: DEV_DATABASE_ROOT_CERTIFICATE_PATH,
    appName: 'manga-nikki-storage-policy-setup',
  });
  env.PGOPTIONS =
    '-c default_transaction_read_only=off -c statement_timeout=15000 -c lock_timeout=5000 -c search_path=pg_catalog';
  try {
    const result = await executor(
      DEV_DATABASE_PSQL_PATH,
      ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', POLICY_SQL_PATH],
      { env, timeout: 30_000, maxBuffer: 32 * 1024, windowsHide: true },
    );
    if (String(result.stdout).trim() !== 'STORAGE_POLICY_TRANSACTION_COMMITTED') throw new Error();
  } catch {
    throw new ProductionPlatformMetadataFailure('STORAGE_POLICY_WRITE_RESULT_UNKNOWN');
  }
}
