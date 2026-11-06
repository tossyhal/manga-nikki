import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DEV_DATABASE_HOST,
  DEV_DATABASE_PORT,
  DEV_DATABASE_NAME,
  DEV_DATABASE_USER,
  DEV_DATABASE_ROOT_CERTIFICATE_PATH,
  verifyPinnedRootCertificate,
} from './dev-database-preflight.ts';
import { runPsqlReadOnlyQuery } from './dev-database-preflight-runner.ts';

type MetadataCode =
  | 'STORAGE_METADATA_INVALID'
  | 'STORAGE_METADATA_QUERY_FAILED'
  | 'STORAGE_POLICY_SETUP_REQUIRED';
export class ProductionPlatformMetadataFailure extends Error {
  readonly code: MetadataCode;
  constructor(code: MetadataCode) {
    super(code);
    this.code = code;
    this.name = 'ProductionPlatformMetadataFailure';
  }
}
export function parseProductionPlatformMetadata(raw: string): {
  ownerPrivilege: boolean;
  ownerSetPrivilege: boolean;
  policiesOk: boolean;
} {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_INVALID');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_INVALID');
  const values = data as Record<string, unknown>;
  const expected = {
    identityOk: true,
    readOnly: true,
    storageRlsOk: true,
    serviceRoleBypassRls: true,
    anonBypassRls: false,
    authenticatedBypassRls: false,
    serviceRoleCanSelectObjects: true,
    serviceRoleCanInsertObjects: true,
    serviceRoleCanDeleteObjects: true,
  };
  if (
    Object.entries(expected).some(([key, value]) => values[key] !== value) ||
    typeof values.storageOwnerPrivilege !== 'boolean' ||
    typeof values.storageOwnerSetPrivilege !== 'boolean' ||
    typeof values.restrictivePoliciesOk !== 'boolean'
  )
    throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_INVALID');
  return {
    ownerPrivilege: values.storageOwnerPrivilege,
    ownerSetPrivilege: values.storageOwnerSetPrivilege,
    policiesOk: values.restrictivePoliciesOk,
  };
}
export async function readProductionPlatformMetadata(
  password: string,
): Promise<{ ownerPrivilege: boolean; ownerSetPrivilege: boolean; policiesOk: boolean }> {
  if (!password) throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_QUERY_FAILED');
  await verifyPinnedRootCertificate(DEV_DATABASE_ROOT_CERTIFICATE_PATH, new Date());
  const sql = await readFile(
    fileURLToPath(
      new URL('../../supabase/operations/production-platform-metadata.sql', import.meta.url),
    ),
    'utf8',
  );
  let raw: string;
  try {
    raw = await runPsqlReadOnlyQuery(sql, {
      connection: {
        host: DEV_DATABASE_HOST,
        port: DEV_DATABASE_PORT,
        database: DEV_DATABASE_NAME,
        user: DEV_DATABASE_USER,
        password,
        sslRootCert: DEV_DATABASE_ROOT_CERTIFICATE_PATH,
        appName: 'manga-nikki-production-platform-metadata',
      },
    });
  } catch {
    throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_QUERY_FAILED');
  }
  return parseProductionPlatformMetadata(raw);
}
