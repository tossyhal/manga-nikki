import page from '../../docs/contracts/comic-page.example.json' with { type: 'json' };
import panels from '../../docs/contracts/comic-panels.example.json' with { type: 'json' };
import { comicSchema } from './schemas';
export const pageComic = /* @__PURE__ */ comicSchema.parse(page);
export const panelsComic = /* @__PURE__ */ comicSchema.parse(panels);
export const sampleDiary = '朝はトーストを食べた。図書館で本を読んだ。帰り道で猫を見かけた。';

// 同じIDで差し替え、画面接続時の待機・成功・失敗を再現するための架空データ。
export function generationFixtures(entryId: string, id: string, entryRevision = 1) {
  const base = { id, entryId, entryRevision, mock: true };
  return {
    queued: { ...base, status: 'queued', stage: null },
    running: { ...base, status: 'running', stage: 'images' },
    succeeded: { ...base, status: 'succeeded', stage: null, comic: pageComic },
    failed: {
      ...base,
      status: 'failed',
      stage: null,
      error: {
        code: 'GENERATION_FAILED',
        message: '漫画を作成できませんでした。',
        retryable: false,
      },
    },
    unknown: {
      ...base,
      status: 'unknown',
      stage: null,
      error: { code: 'RESULT_UNKNOWN', message: '生成結果を確認できません。', retryable: false },
    },
    cancelled: { ...base, status: 'cancelled', stage: null },
  } satisfies Record<string, import('./schemas').Generation>;
}
