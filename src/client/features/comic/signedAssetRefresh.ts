export function shouldRenewExpiredAsset(
  receivedAt: number | undefined,
  attempted: boolean,
  now = performance.now(),
): boolean {
  // 署名URLは60秒で失効するため、通信遅延分を見込んで単調時計で55秒後から更新する。
  return (
    !attempted &&
    receivedAt !== undefined &&
    Number.isFinite(receivedAt) &&
    Number.isFinite(now) &&
    now >= receivedAt + 55_000
  );
}
