import sampleScript from '../../../docs/contracts/script.example.json';
import { scriptSchema } from './script-schema';
import type { CallOptions, DiarySnapshot, ScriptProvider, ScriptResult } from './script-provider';

export const mockScriptModelProfile = {
  provider: 'mock',
  modelId: 'fixed-script-v1',
} as const;

export class MockScriptProvider implements ScriptProvider {
  async createScript(_input: DiarySnapshot, options: CallOptions): Promise<ScriptResult> {
    options.signal.throwIfAborted();
    if (
      options.modelProfile.provider !== mockScriptModelProfile.provider ||
      options.modelProfile.modelId !== mockScriptModelProfile.modelId
    ) {
      throw new Error('UNSUPPORTED_MOCK_SCRIPT_PROFILE');
    }

    // 入力日記とは無関係の固定サンプル。HTTP・DB・外部AIには依存しない。
    // safeParseは検証後のコピーを返すため、呼び出し間で変更が共有されない。
    const result = scriptSchema.safeParse(sampleScript);
    if (!result.success) throw new Error('INVALID_MOCK_SCRIPT');
    return result.data;
  }
}
