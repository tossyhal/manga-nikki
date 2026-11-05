import { beforeEach, describe, expect, it, vi } from 'vitest';
import sample from '../../../docs/contracts/script.example.json';
import { OpenAIScriptProvider, openaiScriptModelProfile } from './openai-script-provider';

const { create, construct } = vi.hoisted(() => ({ create: vi.fn(), construct: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
    constructor(options: unknown) {
      construct(options);
    }
  },
}));
const input = {
  id: crypto.randomUUID(),
  diaryDate: '2026-10-29',
  body: '大学祭でピアノを弾いた。嬉しかった。',
  revision: 1,
};
const options = () => ({
  signal: new AbortController().signal,
  generationId: crypto.randomUUID(),
  callIndex: 1,
  modelProfile: openaiScriptModelProfile,
});
const response = () => ({ status: 'completed', output: [], output_text: JSON.stringify(sample) });
beforeEach(() => {
  create.mockReset().mockResolvedValue(response());
  construct.mockReset();
});
describe('OpenAI脚本Provider', () => {
  it('JSON形式を指定して1回呼び出し、既存の脚本形式で返す', async () => {
    const config = options();
    expect(await new OpenAIScriptProvider('test-key').createScript(input, config)).toEqual(sample);
    expect(construct).toHaveBeenCalledWith({ apiKey: 'test-key', timeout: 120_000, maxRetries: 0 });
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        model: openaiScriptModelProfile.modelId,
        store: false,
        max_output_tokens: 4096,
        input: JSON.stringify({ diaryDate: input.diaryDate, diary: input.body }),
        text: expect.objectContaining({
          format: expect.objectContaining({ type: 'json_schema', strict: true }),
        }),
      }),
      { signal: config.signal },
    );
  });
  it.each([
    [{ ...response(), status: 'incomplete' }, 'OPENAI_INCOMPLETE_OUTPUT'],
    [{ ...response(), output_text: '' }, 'OPENAI_EMPTY_OUTPUT'],
    [{ ...response(), output_text: 'invalid' }, 'OPENAI_INVALID_JSON'],
    [
      { ...response(), output_text: JSON.stringify({ ...sample, panels: [] }) },
      'OPENAI_INVALID_SCRIPT',
    ],
    [
      {
        ...response(),
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private' }] }],
      },
      'OPENAI_REFUSED',
    ],
  ])('不完全・不正な返答を拒否し再送しない', async (result, code) => {
    create.mockResolvedValue(result);
    await expect(
      new OpenAIScriptProvider('key').createScript(input, options()),
    ).rejects.toMatchObject({ code });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ status: 429, code: 'insufficient_quota' }, 'OPENAI_QUOTA_EXCEEDED'],
    [{ status: 429, code: 'rate_limit_exceeded' }, 'OPENAI_RATE_LIMIT'],
    [{ status: 401 }, 'OPENAI_REQUEST_REJECTED'],
    [{ status: 503 }, 'OPENAI_RESULT_UNKNOWN'],
  ])('API失敗を安全なコードに変換する', async (error, code) => {
    create.mockRejectedValue({ ...error, message: 'PRIVATE_DIARY' });
    const result = new OpenAIScriptProvider('key').createScript(input, options());
    await expect(result).rejects.toMatchObject({ code, message: code });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('キーなし・許可外モデル・中断時は送信しない', async () => {
    expect(() => new OpenAIScriptProvider('')).toThrow('OPENAI_KEY_MISSING');
    const provider = new OpenAIScriptProvider('key');
    await expect(
      provider.createScript(input, {
        ...options(),
        modelProfile: { provider: 'gemini', modelId: 'other' },
      }),
    ).rejects.toThrow('OPENAI_MODEL_NOT_ALLOWED');
    await expect(
      provider.createScript(input, { ...options(), signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
  });
});
