import type { CallOptions, ScriptResult } from './script-provider';
import { z } from 'zod';
import { validateImageBytes } from './image-data';

export type RenderedPanel = {
  index: 1 | 2 | 3 | 4;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: Uint8Array;
  requestId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export type RenderedComic = {
  kind: 'panels';
  textMode: 'external';
  modelId: string;
  panels: [RenderedPanel, RenderedPanel, RenderedPanel, RenderedPanel];
};

export interface ImageProvider {
  render(script: ScriptResult, options: CallOptions): Promise<RenderedComic>;
}

const renderedPanelSchema = z.strictObject({
  index: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.instanceof(Uint8Array),
  requestId: z.string().min(1).max(200).optional(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().safe().optional(),
      outputTokens: z.number().int().nonnegative().safe().optional(),
      totalTokens: z.number().int().nonnegative().safe().optional(),
    })
    .optional(),
});
const renderedComicSchema = z.strictObject({
  kind: z.literal('panels'),
  textMode: z.literal('external'),
  modelId: z.string().min(1),
  panels: z.array(renderedPanelSchema).length(4),
});

export function validateRenderedComic(value: unknown, expectedModelId: string): RenderedComic {
  const parsed = renderedComicSchema.safeParse(value);
  if (!parsed.success || parsed.data.modelId !== expectedModelId)
    throw new Error('RENDERED_COMIC_INVALID');
  let totalBytes = 0;
  parsed.data.panels.forEach((panel, index) => {
    if (panel.index !== index + 1) throw new Error('RENDERED_COMIC_INVALID');
    validateImageBytes(panel.data, panel.mediaType);
    totalBytes += panel.data.byteLength;
  });
  if (totalBytes > 16 * 1024 * 1024) throw new Error('RENDERED_COMIC_INVALID');
  return {
    ...parsed.data,
    panels: parsed.data.panels as RenderedComic['panels'],
  };
}
