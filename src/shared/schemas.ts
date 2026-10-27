import { z } from 'zod';

const text = (min: number, max: number) =>
  z.string().refine((s) => {
    const count = [...s].length;
    return count >= min && count <= max;
  }, `${min}〜${max}文字で入力してください。`);
const panel = (index: 1 | 2 | 3 | 4) =>
  z.strictObject({
    index: z.literal(index),
    scene: text(1, 250),
    caption: text(0, 70),
    dialogue: text(0, 70),
  });
export const comicSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: text(1, 40),
  panels: z.tuple([panel(1), panel(2), panel(3), panel(4)]),
  visual: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('page'),
      assetId: z.uuid(),
      textMode: z.enum(['embedded', 'external']),
    }),
    z.strictObject({
      kind: z.literal('panels'),
      assetIds: z
        .tuple([z.uuid(), z.uuid(), z.uuid(), z.uuid()])
        .refine((ids) => new Set(ids).size === 4),
      textMode: z.literal('external'),
    }),
  ]),
});
export type ComicDocument = z.infer<typeof comicSchema>;
export const jstToday = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
const diaryDate = z.iso.date().refine((date) => date <= jstToday(), '未来の日付は指定できません。');
const body = z.string().trim().pipe(text(1, 1000));
export const createEntrySchema = z.strictObject({
  createRequestId: z.uuid(),
  diaryDate,
  body,
  consentVersion: z.literal('v1'),
});
export const updateEntrySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  diaryDate,
  body,
});
export const generateSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  captchaToken: z.string(),
});
export type Entry = {
  id: string;
  diaryDate: string;
  body: string;
  revision: number;
  latestGenerationId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type GenerationError = { code: string; message: string; retryable: boolean };
type GenerationBase = { id: string; entryId: string; mock: boolean };
export type Generation = GenerationBase &
  (
    | { status: 'queued'; stage: null; comic?: never }
    | { status: 'running'; stage: 'script' | 'images' | 'saving'; comic?: never }
    | { status: 'succeeded'; stage: null; comic: ComicDocument }
    | { status: 'failed' | 'unknown'; stage: null; comic?: never; error: GenerationError }
    | { status: 'cancelled'; stage: null; comic?: never }
  );
export type EntryDetail = Entry & { latestGeneration: Generation | null };
