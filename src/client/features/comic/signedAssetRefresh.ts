export function shouldRenewExpiredAsset(
  expiresAt: number | undefined,
  attempted: boolean,
  now = Date.now(),
): boolean {
  return !attempted && expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= now;
}
