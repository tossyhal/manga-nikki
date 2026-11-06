export function shouldRenewExpiredAsset(
  requestedAt: number | undefined,
  requestedAtWall: number | undefined,
  attempted: boolean,
  now = performance.now(),
  wallNow = Date.now(),
  expiresAt?: string,
): boolean {
  // 単調時計が端末スリープ中に止まる環境もあるため、両時計の経過時間の大きい方を使う。
  if (
    attempted ||
    requestedAt === undefined ||
    requestedAtWall === undefined ||
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(requestedAtWall) ||
    !Number.isFinite(now) ||
    !Number.isFinite(wallNow)
  )
    return false;

  const elapsed = Math.max(now - requestedAt, wallNow - requestedAtWall);
  if (elapsed < 55_000) return false;
  if (!expiresAt) return true;

  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return true;
  // expiresAtはserver clock由来なので、client clockだけで期限切れと決めず経過時間も確認する。
  return wallNow >= expiry || elapsed >= 65_000;
}

export function shouldRefreshExpiredAssetOnVisibility(
  requestedAt: number | undefined,
  requestedAtWall: number | undefined,
  attempted: boolean,
  expiresAt: string,
  now = performance.now(),
  wallNow = Date.now(),
): boolean {
  if (
    attempted ||
    requestedAt === undefined ||
    requestedAtWall === undefined ||
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(requestedAtWall) ||
    !Number.isFinite(now) ||
    !Number.isFinite(wallNow)
  )
    return false;

  const elapsed = Math.max(now - requestedAt, wallNow - requestedAtWall);
  const expiry = Date.parse(expiresAt);
  // visibilitychangeは一度だけの再取得に限り、端末時計が期限を過ぎた時も再表示を回復する。
  return (Number.isFinite(expiry) && wallNow >= expiry) || elapsed >= 65_000;
}
