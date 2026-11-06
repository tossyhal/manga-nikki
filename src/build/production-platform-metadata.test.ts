import { describe, expect, it } from 'vitest';
import { parseProductionPlatformMetadata } from './production-platform-metadata.ts';
const valid = {
  identityOk: true,
  readOnly: true,
  storageRlsOk: true,
  storageOwnerPrivilege: false,
  storageOwnerSetPrivilege: false,
  restrictivePoliciesOk: true,
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
      ownerPrivilege: false,
      ownerSetPrivilege: false,
      policiesOk: true,
    });
  });
  it('policy不足を成功扱いにしないための状態を返す', () => {
    expect(
      parseProductionPlatformMetadata(JSON.stringify({ ...valid, restrictivePoliciesOk: false }))
        .policiesOk,
    ).toBe(false);
  });
  it.each([
    { storageRlsOk: false },
    { anonBypassRls: true },
    { readOnly: false },
    { restrictivePoliciesOk: null },
  ])('不正なmetadataは拒否する %j', (override) => {
    expect(() =>
      parseProductionPlatformMetadata(JSON.stringify({ ...valid, ...override })),
    ).toThrow('STORAGE_METADATA_INVALID');
  });
});
