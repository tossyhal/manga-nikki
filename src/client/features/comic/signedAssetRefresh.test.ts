import { describe, expect, it } from 'vitest';
import { shouldRenewExpiredAsset } from './signedAssetRefresh';

describe('expired signed asset refresh', () => {
  const requestedAt = 10_000;
  const requestedAtWall = 1_800_000_000_000;

  it('renews once after the signed URL age limit, including images first loaded lazily', () => {
    expect(
      shouldRenewExpiredAsset(
        requestedAt,
        requestedAtWall,
        false,
        requestedAt + 55_000,
        requestedAtWall + 55_000,
      ),
    ).toBe(true);
    expect(
      shouldRenewExpiredAsset(
        requestedAt,
        requestedAtWall,
        true,
        requestedAt + 55_000,
        requestedAtWall + 55_000,
      ),
    ).toBe(false);
  });

  it('counts network time before the response arrives', () => {
    const responseArrivesAt = requestedAt + 10_000;
    expect(
      shouldRenewExpiredAsset(
        requestedAt,
        requestedAtWall,
        false,
        responseArrivesAt + 51_000,
        requestedAtWall + 61_000,
      ),
    ).toBe(true);
  });

  it('uses elapsed wall time when the monotonic clock pauses during device sleep', () => {
    expect(
      shouldRenewExpiredAsset(
        requestedAt,
        requestedAtWall,
        false,
        requestedAt + 20_000,
        requestedAtWall + 60_000,
      ),
    ).toBe(true);
  });

  it('uses elapsed time only so positive and negative clock offsets do not change the threshold', () => {
    const aheadClockAtRequest = requestedAtWall + 86_400_000;
    const behindClockAtRequest = requestedAtWall - 86_400_000;
    expect(
      shouldRenewExpiredAsset(
        requestedAt,
        aheadClockAtRequest,
        false,
        requestedAt + 54_999,
        aheadClockAtRequest + 54_999,
      ),
    ).toBe(false);
    expect(
      shouldRenewExpiredAsset(
        requestedAt,
        behindClockAtRequest,
        false,
        requestedAt + 55_000,
        behindClockAtRequest + 55_000,
      ),
    ).toBe(true);
    expect(
      shouldRenewExpiredAsset(
        requestedAt,
        requestedAtWall,
        false,
        requestedAt + 55_000,
        requestedAtWall - 3_600_000,
      ),
    ).toBe(true);
  });

  it('does not renew before the age limit or without valid request times', () => {
    expect(
      shouldRenewExpiredAsset(
        requestedAt,
        requestedAtWall,
        false,
        requestedAt + 54_999,
        requestedAtWall + 54_999,
      ),
    ).toBe(false);
    expect(
      shouldRenewExpiredAsset(
        requestedAt + 1,
        requestedAtWall + 1,
        false,
        requestedAt,
        requestedAtWall,
      ),
    ).toBe(false);
    expect(shouldRenewExpiredAsset(undefined, requestedAtWall, false)).toBe(false);
    expect(shouldRenewExpiredAsset(Number.NaN, requestedAtWall, false)).toBe(false);
    expect(shouldRenewExpiredAsset(requestedAt, Number.NaN, false)).toBe(false);
    expect(shouldRenewExpiredAsset(requestedAt, requestedAtWall, false, Number.NaN)).toBe(false);
  });
});
