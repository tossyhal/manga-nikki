import type { ProviderCallMetadata } from './ai/provider-attempts';
import type { RenderedComic } from './ai/image-provider';
import type { ScriptResult } from './ai/script-provider';
import type { Environment } from './mode';

export type ClaimedOpenAIGeneration = Readonly<{
  generationId: string;
  entryId: string;
  ownerId: string;
  entryRevision: number;
  diaryDate: string;
  claimToken: string;
  deadlineAt: string;
}>;

export type SaveGeneratedComicInput = Readonly<{
  generation: ClaimedOpenAIGeneration;
  profileId: string;
  script: ScriptResult;
  rendered: RenderedComic;
  providerCalls: Readonly<{
    script: ProviderCallMetadata;
    images: readonly ProviderCallMetadata[];
  }>;
}>;

export type SaveGeneratedComicResult = Readonly<{
  generationId: string;
  status: 'succeeded';
}>;

export type SaveGeneratedComicContext = Readonly<{
  environment: Environment;
  signal: AbortSignal;
}>;

// 非公開画像とDBの完了確定が済んだ後にだけresolveする。
export type SaveGeneratedComic = (
  input: SaveGeneratedComicInput,
  context: SaveGeneratedComicContext,
) => Promise<SaveGeneratedComicResult>;
