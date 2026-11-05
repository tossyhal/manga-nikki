import type { CallOptions, ScriptResult } from './script-provider';

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
