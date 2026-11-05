import { describe, expect, it } from 'vitest';
import { shouldRenewExpiredAsset } from './signedAssetRefresh';

describe('expired signed asset refresh', () => {
  const now = 1_800_000_000_000;

  it('renews once after expiry, including images first loaded lazily', () => {
    expect(shouldRenewExpiredAsset(now - 1, false, now)).toBe(true);
    expect(shouldRenewExpiredAsset(now - 1, true, now)).toBe(false);
  });

  it('does not renew a still-valid URL or missing expiry metadata', () => {
    expect(shouldRenewExpiredAsset(now + 1, false, now)).toBe(false);
    expect(shouldRenewExpiredAsset(undefined, false, now)).toBe(false);
    expect(shouldRenewExpiredAsset(Number.NaN, false, now)).toBe(false);
  });
});
