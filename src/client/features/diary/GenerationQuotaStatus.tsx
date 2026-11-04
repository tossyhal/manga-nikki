import { Link } from 'react-router';
import type { Generation } from '../../../shared/schemas';
import type { GenerationQuota } from '../../lib/api';

function resetLabel(resetAt: string): string | null {
  const date = new Date(resetAt);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function GenerationQuotaStatus({
  quota,
  activeGeneration,
  currentEntryId,
  currentGenerationId,
}: {
  quota: GenerationQuota;
  activeGeneration: Generation | null;
  currentEntryId?: string;
  currentGenerationId?: string | null;
}) {
  const nextReset = resetLabel(quota.resetAt);
  const showOtherActiveGeneration =
    quota.activeGenerationId !== null && quota.activeGenerationId !== currentGenerationId;

  return (
    <section aria-label="本日の漫画生成枠">
      <p className="hint">
        {quota.remainingToday === 0
          ? `本日の生成上限に達しています。${nextReset ? `利用枠は${nextReset}に更新されます。` : ''}`
          : `本日の残り生成枠は${quota.remainingToday}回です。`}
      </p>
      {!quota.generationAvailable && (
        <p className="hint">
          現在、漫画の受付を停止しています。保存済みの記録は引き続き見られます。
        </p>
      )}
      {showOtherActiveGeneration && (
        <p className="hint">
          {activeGeneration?.status === 'unknown'
            ? '別の漫画の結果を確認中です。自動では再生成しません。'
            : '別の漫画を作成しています。'}{' '}
          {activeGeneration && activeGeneration.entryId !== currentEntryId ? (
            <Link to={`/entries/${encodeURIComponent(activeGeneration.entryId)}`}>
              進行中の記録を見る
            </Link>
          ) : (
            '記録の一覧から進行状況を確認してください。'
          )}
        </p>
      )}
    </section>
  );
}
