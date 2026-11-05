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

// 保存再開に必要な情報を早い段階で永続化し、非公開画像とDBの完了確定後だけresolveする。
export type SaveGeneratedComic = (
  input: SaveGeneratedComicInput,
  context: SaveGeneratedComicContext,
) => Promise<SaveGeneratedComicResult>;

export class GenerationSavePendingError extends Error {
  constructor() {
    super('GENERATION_SAVE_PENDING');
    this.name = 'GenerationSavePendingError';
  }
}

export type RecoverGeneratedComicResult = Readonly<{
  generationId: string;
  // pendingはsavingを保持し、他の値はcallbackが永続化と状態確定を済ませた後に返す。
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
}>;

// generationの永続化データから復旧し、owner・期限・削除・取消とstorage leaseを検査する。
// 永続化から復旧できない場合は安全に終端化し、AI providerを呼び直さない。
export type RecoverGeneratedComic = (
  generationId: string,
  context: SaveGeneratedComicContext,
) => Promise<RecoverGeneratedComicResult>;
