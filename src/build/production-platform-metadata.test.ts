import { describe, expect, it } from 'vitest';
import {
  parseProductionPlatformMetadata,
  validateStoragePolicyOperation,
  assertStoragePolicySetupAllowed,
} from './production-platform-metadata.ts';
const valid = {
  identityOk: true,
  readOnly: true,
  storageRlsOk: true,
  storageOwnerPrivilege: false,
  storagePolicyDelegated: false,
  storageOwnerSetPrivilege: false,
  restrictivePoliciesOk: true,
  sameStorageOwner: true,
  missingPolicyCount: 0,
  mismatchedPolicyCount: 0,
  serviceRoleBypassRls: true,
  anonBypassRls: false,
  authenticatedBypassRls: false,
  serviceRoleCanSelectObjects: true,
  serviceRoleCanInsertObjects: true,
  serviceRoleCanDeleteObjects: true,
};
describe('Storage metadata', () => {
  it('table owner権限がない場合もread-only情報として区別する', () => {
    expect(parseProductionPlatformMetadata(JSON.stringify(valid))).toEqual({
      sameStorageOwner: true,
      missingPolicyCount: 0,
      mismatchedPolicyCount: 0,
      ownerPrivilege: false,
      policyDelegated: false,
      ownerSetPrivilege: false,
      policiesOk: true,
    });
  });
  it('policy不足を成功扱いにしないための状態を返す', () => {
    expect(
      parseProductionPlatformMetadata(
        JSON.stringify({ ...valid, restrictivePoliciesOk: false, missingPolicyCount: 2 }),
      ).policiesOk,
    ).toBe(false);
  });
  it.each([
    { storageRlsOk: false },
    { anonBypassRls: true },
    { readOnly: false },
    { restrictivePoliciesOk: null },
    { storagePolicyDelegated: undefined },
    { storagePolicyDelegated: 'true' },
  ])('不正なmetadataは拒否する %j', (override) => {
    expect(() =>
      parseProductionPlatformMetadata(JSON.stringify({ ...valid, ...override })),
    ).toThrow('STORAGE_METADATA_INVALID');
  });
});

describe('Storage policy setup gate', () => {
  it.each(['2', undefined])('初回以外のwriteを拒否する %s', (attempt) => {
    expect(() =>
      validateStoragePolicyOperation({
        PRODUCTION_PLATFORM_OPERATION: 'setup-storage-policies',
        PRODUCTION_PLATFORM_CONFIRMATION: 'manga-nikki-generations-production',
        GITHUB_RUN_ATTEMPT: attempt,
      }),
    ).toThrow('STORAGE_METADATA_INVALID');
  });
  it('明示確認した初回の手動操作だけ許可する', () => {
    expect(
      validateStoragePolicyOperation({
        PRODUCTION_PLATFORM_OPERATION: 'setup-storage-policies',
        PRODUCTION_PLATFORM_CONFIRMATION: 'manga-nikki-generations-production',
        GITHUB_RUN_ATTEMPT: '1',
      }),
    ).toBe(true);
  });
  it('既存不一致を上書き対象にしない', () => {
    expect(() =>
      assertStoragePolicySetupAllowed({
        ownerPrivilege: true,
        policyDelegated: false,
        ownerSetPrivilege: true,
        sameStorageOwner: true,
        missingPolicyCount: 1,
        mismatchedPolicyCount: 1,
        policiesOk: false,
      }),
    ).toThrow('STORAGE_POLICY_MISMATCH');
  });
  it('固定2tableへの正式なpolicy委任があればowner membershipなしで許可する', () => {
    const metadata = parseProductionPlatformMetadata(
      JSON.stringify({
        ...valid,
        storagePolicyDelegated: true,
        restrictivePoliciesOk: false,
        missingPolicyCount: 2,
      }),
    );
    expect(metadata.policyDelegated).toBe(true);
    expect(() => assertStoragePolicySetupAllowed(metadata)).not.toThrow();
    expect(() =>
      assertStoragePolicySetupAllowed({
        ...metadata,
        mismatchedPolicyCount: 1,
        missingPolicyCount: 1,
      }),
    ).toThrow('STORAGE_POLICY_MISMATCH');
    expect(() => assertStoragePolicySetupAllowed({ ...metadata, sameStorageOwner: false })).toThrow(
      'STORAGE_POLICY_OWNER_ACTION_REQUIRED',
    );
  });
  it('owner権限のない不足policyを作成しない', () => {
    expect(() =>
      assertStoragePolicySetupAllowed({
        ownerPrivilege: false,
        policyDelegated: false,
        ownerSetPrivilege: false,
        sameStorageOwner: true,
        missingPolicyCount: 2,
        mismatchedPolicyCount: 0,
        policiesOk: false,
      }),
    ).toThrow('STORAGE_POLICY_OWNER_ACTION_REQUIRED');
  });
});
