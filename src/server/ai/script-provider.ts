import type { z } from 'zod';
import type { Entry } from '../../shared/schemas';
import type { ProviderAttemptHooks } from './provider-attempts';
import { scriptSchema } from './script-schema';

// 生成を開始した時点の日記。Providerは元の日記やDBを変更しない。
export type DiarySnapshot = Readonly<Pick<Entry, 'id' | 'diaryDate' | 'body' | 'revision'>>;
export type ScriptResult = z.infer<typeof scriptSchema>;

// サーバー側で選択した設定。ブラウザからモデルを指定させない。
export type CallOptions = Readonly<{
  signal: AbortSignal;
  generationId: string;
  callIndex: number;
  modelProfile: Readonly<{ provider: string; modelId: string }>;
  attemptHooks?: ProviderAttemptHooks;
}>;

export interface ScriptProvider {
  createScript(input: DiarySnapshot, options: CallOptions): Promise<ScriptResult>;
}
