export function shouldRenewExpiredAsset(
  requestedAt: number | undefined,
  requestedAtWall: number | undefined,
  attempted: boolean,
  now = performance.now(),
  wallNow = Date.now(),
): boolean {
  // 単調時計が端末スリープ中に止まる環境もあるため、両時計の経過時間の大きい方を使う。
  return (
    !attempted &&
    requestedAt !== undefined &&
    requestedAtWall !== undefined &&
    Number.isFinite(requestedAt) &&
    Number.isFinite(requestedAtWall) &&
    Number.isFinite(now) &&
    Number.isFinite(wallNow) &&
    Math.max(now - requestedAt, wallNow - requestedAtWall) >= 55_000
  );
}
