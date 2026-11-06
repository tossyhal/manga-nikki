import { Link } from 'react-router';
import type { Generation } from '../../../shared/schemas';
import type { GenerationQuota } from '../../lib/api';

export function GenerationQuotaStatus({
  quota,
  activeGeneration,
  currentEntryId,
  currentGenerationId,
  generationAvailable,
}: {
  quota: GenerationQuota;
  activeGeneration: Generation | null;
  currentEntryId?: string;
  currentGenerationId?: string | null;
  generationAvailable: boolean;
}) {
  const showOtherActiveGeneration =
    quota.activeGenerationId !== null && quota.activeGenerationId !== currentGenerationId;

  if (showOtherActiveGeneration)
    return (
      <output className="generation-status-note">
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
      </output>
    );

  if (!generationAvailable)
    return (
      <output className="generation-status-note">
        現在、漫画の受付を停止しています。保存済みの記録は引き続き見られます。
      </output>
    );

  if (quota.remainingToday === 0)
    return <output className="generation-status-note">本日の生成上限に達しています。</output>;

  if (!quota.generationAvailable)
    return (
      <output className="generation-status-note">
        現在、漫画の受付を停止しています。保存済みの記録は引き続き見られます。
      </output>
    );

  return null;
}
