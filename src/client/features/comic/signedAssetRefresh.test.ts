import { describe, expect, it } from 'vitest';
import { shouldRenewExpiredAsset } from './signedAssetRefresh';

describe('expired signed asset refresh', () => {
  const receivedAt = 10_000;

  it('renews once after the signed URL age limit, including images first loaded lazily', () => {
    expect(shouldRenewExpiredAsset(receivedAt, false, receivedAt + 55_000)).toBe(true);
    expect(shouldRenewExpiredAsset(receivedAt, true, receivedAt + 55_000)).toBe(false);
  });

  it('does not renew before the age limit or without a receive time', () => {
    expect(shouldRenewExpiredAsset(receivedAt, false, receivedAt + 54_999)).toBe(false);
    expect(shouldRenewExpiredAsset(receivedAt + 1, false, receivedAt)).toBe(false);
    expect(shouldRenewExpiredAsset(undefined, false, receivedAt + 55_000)).toBe(false);
    expect(shouldRenewExpiredAsset(Number.NaN, false, receivedAt + 55_000)).toBe(false);
    expect(shouldRenewExpiredAsset(receivedAt, false, Number.NaN)).toBe(false);
  });
});
