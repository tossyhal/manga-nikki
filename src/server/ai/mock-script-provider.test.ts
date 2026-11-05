import { describe, expect, it, vi } from 'vitest';
import sampleScript from '../../../docs/contracts/script.example.json';
import { MockScriptProvider, mockScriptModelProfile } from './mock-script-provider';
import { scriptSchema } from './script-schema';
import type { CallOptions, DiarySnapshot, ScriptProvider } from './script-provider';

const input: DiarySnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  diaryDate: '2026-10-29',
  body: '架空の日記です。',
  revision: 1,
};
const options = (): CallOptions => ({
  signal: new AbortController().signal,
  generationId: crypto.randomUUID(),
  callIndex: 1,
  modelProfile: mockScriptModelProfile,
});

describe('モックのScriptProvider', () => {
  it('共通インターフェースで検証済みの固定脚本を返す', async () => {
    const provider: ScriptProvider = new MockScriptProvider();
    const result = await provider.createScript(input, options());
    expect(result).toEqual(sampleScript);
    expect(scriptSchema.safeParse(result).success).toBe(true);
  });

  it('入力に関係なく固定結果を返し、入力を変更しない', async () => {
    const provider = new MockScriptProvider();
    const snapshot = structuredClone(input);
    Object.freeze(snapshot);
    const first = await provider.createScript(snapshot, options());
    const second = await provider.createScript({ ...input, body: '別の架空日記。' }, options());
    expect(first).toEqual(second);
    expect(snapshot).toEqual(input);
  });

  it('返された脚本を編集しても次の呼び出しを汚染しない', async () => {
    const provider = new MockScriptProvider();
    const first = await provider.createScript(input, options());
    first.panels[0].scene = '変更した場面';
    const second = await provider.createScript(input, options());
    expect(second).toEqual(sampleScript);
  });

  it('中断済みなら脚本検証へ進まない', async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = vi.spyOn(scriptSchema, 'safeParse');
    try {
      await expect(
        new MockScriptProvider().createScript(input, { ...options(), signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('想定外のモデル設定を拒否する', async () => {
    await expect(
      new MockScriptProvider().createScript(input, {
        ...options(),
        modelProfile: { provider: 'external', modelId: 'not-approved' },
      }),
    ).rejects.toThrow('UNSUPPORTED_MOCK_SCRIPT_PROFILE');
  });

  it('不正なサンプルを成功として返さない', async () => {
    const invalid = scriptSchema.safeParse({});
    const spy = vi.spyOn(scriptSchema, 'safeParse').mockReturnValueOnce(invalid);
    try {
      await expect(new MockScriptProvider().createScript(input, options())).rejects.toThrow(
        'INVALID_MOCK_SCRIPT',
      );
    } finally {
      spy.mockRestore();
    }
  });
});
