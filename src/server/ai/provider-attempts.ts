export type ProviderStage = 'script' | 'images';
export type ProviderAttemptState = 'succeeded' | 'failed' | 'unknown';

export type ProviderUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}>;

export type ProviderCallMetadata = Readonly<{
  stage: ProviderStage;
  callIndex: number;
  modelId: string;
  requestId?: string;
  usage?: ProviderUsage;
}>;

export type ProviderAttemptOutcome = Readonly<{
  state: ProviderAttemptState;
  requestId?: string;
  metadata?: ProviderCallMetadata;
}>;

export type ProviderAttemptHandle = Readonly<{
  callIndex: number;
  attemptId: string;
}>;

export interface ProviderAttemptHooks {
  begin(stage: ProviderStage, callIndex: number): Promise<string>;
  beginBatch?(
    stage: ProviderStage,
    callIndices: readonly number[],
  ): Promise<readonly ProviderAttemptHandle[]>;
  finish(
    stage: ProviderStage,
    callIndex: number,
    attemptId: string,
    outcome: ProviderAttemptOutcome,
  ): Promise<void>;
}
