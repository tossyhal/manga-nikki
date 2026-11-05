import { z } from 'zod';
import { comicSchema, type Generation } from '../shared/schemas';

export const generationRowSchema = z.object({
  id: z.uuid(),
  entry_id: z.uuid(),
  entry_revision: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled']),
  stage: z.enum(['script', 'images', 'saving']).nullable(),
  comic_json: z.unknown().nullable(),
  is_mock: z.boolean().nullable(),
});
export function parseGenerationRow(value: unknown): Generation | null {
  const parsed = generationRowSchema.safeParse(value);
  if (!parsed.success || parsed.data.is_mock === null) return null;
  const row = parsed.data;
  const base = {
    id: row.id,
    entryId: row.entry_id,
    entryRevision: row.entry_revision,
    mock: parsed.data.is_mock,
  };
  if (row.status === 'queued') {
    if (row.stage !== null) return null;
    return { ...base, status: 'queued', stage: null };
  }
  if (row.status === 'running') {
    if (!row.stage) return null;
    return { ...base, status: 'running', stage: row.stage };
  }
  if (row.stage !== null) return null;
  if (row.status === 'succeeded') {
    const comic = comicSchema.safeParse(row.comic_json);
    if (!comic.success) return null;
    return { ...base, status: 'succeeded', stage: null, comic: comic.data };
  }
  if (row.status === 'failed' || row.status === 'unknown') {
    const unknown = row.status === 'unknown';
    return {
      ...base,
      status: row.status,
      stage: null,
      error: {
        code: unknown ? 'RESULT_UNKNOWN' : 'GENERATION_FAILED',
        message: unknown ? '生成結果を確認できません。' : '漫画を作成できませんでした。',
        retryable: false,
      },
    };
  }
  return { ...base, status: 'cancelled', stage: null };
}
