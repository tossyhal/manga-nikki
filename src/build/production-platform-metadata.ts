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
  | 'STORAGE_POLICY_SETUP_REQUIRED'
  | 'STORAGE_POLICY_OWNER_ACTION_REQUIRED'
  | 'STORAGE_POLICY_MISMATCH'
  | 'STORAGE_POLICY_WRITE_RESULT_UNKNOWN';
export class ProductionPlatformMetadataFailure extends Error {
  readonly code: MetadataCode;
  constructor(code: MetadataCode) {
    super(code);
    this.code = code;
    this.name = 'ProductionPlatformMetadataFailure';
  }
}
export type ProductionPlatformMetadata = {
  ownerPrivilege: boolean;
  policyDelegated: boolean;
  ownerSetPrivilege: boolean;
  sameStorageOwner: boolean;
  missingPolicyCount: number;
  mismatchedPolicyCount: number;
  policiesOk: boolean;
};
export function parseProductionPlatformMetadata(raw: string): ProductionPlatformMetadata {
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
    typeof values.storagePolicyDelegated !== 'boolean' ||
    typeof values.storageOwnerSetPrivilege !== 'boolean' ||
    typeof values.restrictivePoliciesOk !== 'boolean' ||
    typeof values.sameStorageOwner !== 'boolean' ||
    !Number.isInteger(values.missingPolicyCount) ||
    !Number.isInteger(values.mismatchedPolicyCount) ||
    Number(values.missingPolicyCount) < 0 ||
    Number(values.missingPolicyCount) > 2 ||
    Number(values.mismatchedPolicyCount) < 0 ||
    Number(values.mismatchedPolicyCount) > 2 ||
    Number(values.missingPolicyCount) + Number(values.mismatchedPolicyCount) > 2 ||
    values.restrictivePoliciesOk !==
      (values.missingPolicyCount === 0 && values.mismatchedPolicyCount === 0)
  )
    throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_INVALID');
  return {
    sameStorageOwner: values.sameStorageOwner,
    policyDelegated: values.storagePolicyDelegated,
    missingPolicyCount: Number(values.missingPolicyCount),
    mismatchedPolicyCount: Number(values.mismatchedPolicyCount),
    ownerPrivilege: values.storageOwnerPrivilege,
    ownerSetPrivilege: values.storageOwnerSetPrivilege,
    policiesOk: values.restrictivePoliciesOk,
  };
}
export function validateStoragePolicyOperation(environment: NodeJS.ProcessEnv): boolean {
  const operation = environment.PRODUCTION_PLATFORM_OPERATION;
  if (!['check', 'setup', 'probe-storage', 'setup-storage-policies'].includes(operation ?? '')) {
    throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_INVALID');
  }
  const apply = operation === 'setup-storage-policies';
  if (
    apply &&
    (environment.PRODUCTION_PLATFORM_CONFIRMATION !== 'manga-nikki-generations-production' ||
      environment.GITHUB_RUN_ATTEMPT !== '1')
  ) {
    throw new ProductionPlatformMetadataFailure('STORAGE_METADATA_INVALID');
  }
  return apply;
}
export function assertStoragePolicySetupAllowed(metadata: ProductionPlatformMetadata): void {
  if (metadata.mismatchedPolicyCount !== 0)
    throw new ProductionPlatformMetadataFailure('STORAGE_POLICY_MISMATCH');
  if (
    !metadata.sameStorageOwner ||
    (!metadata.policiesOk &&
      !metadata.ownerPrivilege &&
      !metadata.ownerSetPrivilege &&
      !metadata.policyDelegated)
  ) {
    throw new ProductionPlatformMetadataFailure('STORAGE_POLICY_OWNER_ACTION_REQUIRED');
  }
}

export async function readProductionPlatformMetadata(
  password: string,
): Promise<ProductionPlatformMetadata> {
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
