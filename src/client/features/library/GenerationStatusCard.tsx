import type { Generation } from '../../../shared/schemas';
import { Icon } from '../../app/Icon';

function generationStateMessage(generation: Generation, isCurrentRevision: boolean): string {
  if (generation.status === 'unknown') {
    return `${isCurrentRevision ? '' : '編集前の日記に対するjobです。'}結果の確認を待っています。自動では再生成せず、利用枠を保持しています。状態を再確認してください。`;
  }
  if (generation.status === 'failed') {
    return isCurrentRevision
      ? '漫画を作成できませんでした。日記は保存されています。本文を編集して保存すると新しく受付できます。'
      : '編集前の日記に対する生成に失敗しました。現在の日記の生成状態ではありません。';
  }
  return isCurrentRevision
    ? '生成は中止されました。日記は保存されています。'
    : '編集前の日記に対する生成は中止されました。現在の日記の生成状態ではありません。';
}

function generationStageMessage(generation: Generation, isCurrentRevision: boolean): string {
  const previousRevisionNote = isCurrentRevision ? '' : '編集前の日記に対するjobです。';
  if (generation.status === 'queued')
    return `${previousRevisionNote}受付済みです。生成を待っています。`;
  if (generation.status !== 'running') return '';
  if (generation.stage === 'script') return `${previousRevisionNote}構成（脚本）を作成しています。`;
  if (generation.stage === 'images') return `${previousRevisionNote}画像を描いています。`;
  return `${previousRevisionNote}漫画を保存しています。`;
}

export function GenerationStatusCard({
  generation,
  referenceUnavailable,
  isCurrentRevision = true,
}: {
  generation: Generation | null | undefined;
  referenceUnavailable: boolean;
  isCurrentRevision?: boolean;
}) {
  const revisionClass = isCurrentRevision ? '' : ' generation-card--previous-revision';
  const stageIndex =
    generation?.status === 'running'
      ? ['script', 'images', 'saving'].indexOf(generation.stage)
      : -1;
  return (
    <>
      {generation?.status === 'queued' && (
        <section className={`generation-card${revisionClass}`} aria-live="polite">
          <Icon name="clock" size={40} />
          <h2>{isCurrentRevision ? '受付済み' : '編集前の生成を受付済み'}</h2>
          <p>順番に処理しています。</p>
          <p className="generation-card-note">画面を閉じても、あとで確認できます。</p>
        </section>
      )}
      {generation?.status === 'running' && (
        <section className={`generation-card${revisionClass}`} aria-live="polite">
          <Icon name="clock" size={40} />
          <h2>
            {!isCurrentRevision
              ? '編集前の生成を処理しています'
              : generation.stage === 'script'
                ? '構成を考えています'
                : generation.stage === 'images'
                  ? '画像を描いています'
                  : '漫画を保存しています'}
          </h2>
          <p>{generationStageMessage(generation, isCurrentRevision)}</p>
          <ol className="generation-steps" aria-label="生成の進行段階">
            {['構成を考える', '絵を描く', '保存する'].map((label, index) => (
              <li
                key={label}
                className={
                  index < stageIndex ? 'is-complete' : index === stageIndex ? 'is-current' : ''
                }
                aria-current={index === stageIndex ? 'step' : undefined}
              >
                <span className="generation-step-icon" aria-hidden="true">
                  {index < stageIndex ? <Icon name="check" size={14} /> : null}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </section>
      )}
      {generation?.status === 'unknown' && (
        <section className={`generation-card${revisionClass}`} aria-live="polite">
          <Icon name="clock" size={40} />
          <h2>{isCurrentRevision ? '状態を再確認してください' : '編集前の生成結果を確認中'}</h2>
          <p>{generationStateMessage(generation, isCurrentRevision)}</p>
        </section>
      )}
      {generation?.status === 'failed' && (
        <section className={`generation-card${revisionClass}`} role="alert">
          <Icon name="alert" size={40} />
          <h2>{isCurrentRevision ? '日記は保存されています' : '編集前の生成に失敗しました'}</h2>
          <p>{generationStateMessage(generation, isCurrentRevision)}</p>
        </section>
      )}
      {generation?.status === 'cancelled' && (
        <section className={`generation-card${revisionClass}`}>
          <Icon name="close" size={40} />
          <h2>{isCurrentRevision ? '日記は保存されています' : '編集前の生成は中止されました'}</h2>
          <p>{generationStateMessage(generation, isCurrentRevision)}</p>
        </section>
      )}
      {referenceUnavailable && (
        <section className="generation-card" role="alert">
          <Icon name="alert" size={40} />
          <h2>漫画の状態を確認できません</h2>
          <p>状態が確認できるまで新しい生成は受け付けません。</p>
        </section>
      )}
    </>
  );
}
