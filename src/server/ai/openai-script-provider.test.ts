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
const response = () => ({
  status: 'completed',
  output: [],
  output_text: JSON.stringify(sample),
  usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
});
const apiRequest = (data: unknown, requestId: string | null = 'request-test') => ({
  withResponse: vi.fn(async () => ({
    data: await data,
    request: new Response(),
    request_id: requestId,
  })),
});
beforeEach(() => {
  create.mockReset().mockReturnValue(apiRequest(response()));
  construct.mockReset();
});
describe('OpenAI脚本Provider', () => {
  it('JSON形式を指定して1回呼び出し、既存の脚本形式で返す', async () => {
    const config = options();
    expect(await new OpenAIScriptProvider('test-key').createScript(input, config)).toEqual(sample);
    expect(construct).toHaveBeenCalledWith({
      apiKey: 'test-key',
      timeout: 120_000,
      maxRetries: 0,
      logLevel: 'off',
    });
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
    expect(create.mock.results[0]?.value.withResponse).toHaveBeenCalledOnce();
  });
  it('送信前に台帳を開始し、responseのrequest IDとusageを確定へ渡す', async () => {
    const hooks = {
      begin: vi.fn(async () => 'attempt-id'),
      finish: vi.fn(async () => undefined),
    };
    const config = { ...options(), attemptHooks: hooks };

    await new OpenAIScriptProvider('test-key').createScript(input, config);

    expect(hooks.begin).toHaveBeenCalledExactlyOnceWith('script', 1);
    expect(hooks.finish).toHaveBeenCalledExactlyOnceWith('script', 1, 'attempt-id', {
      state: 'succeeded',
      requestId: 'request-test',
      metadata: {
        stage: 'script',
        callIndex: 1,
        modelId: openaiScriptModelProfile.modelId,
        requestId: 'request-test',
        usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      },
    });
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
    create.mockReturnValue(apiRequest(result));
    await expect(
      new OpenAIScriptProvider('key').createScript(input, options()),
    ).rejects.toMatchObject({ code });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ status: 429, code: 'insufficient_quota' }, 'OPENAI_QUOTA_EXCEEDED'],
    [{ status: 429, code: 'rate_limit_exceeded' }, 'OPENAI_RATE_LIMIT'],
    [{ status: 401 }, 'OPENAI_REQUEST_REJECTED'],
    [{ status: 408 }, 'OPENAI_RESULT_UNKNOWN'],
    [{ status: 409 }, 'OPENAI_RESULT_UNKNOWN'],
    [{ status: 503 }, 'OPENAI_RESULT_UNKNOWN'],
  ])('API失敗を安全なコードに変換する', async (error, code) => {
    create.mockReturnValue(apiRequest(Promise.reject({ ...error, message: 'PRIVATE_DIARY' })));
    const result = new OpenAIScriptProvider('key').createScript(input, options());
    await expect(result).rejects.toMatchObject({ code, message: code });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ status: 401, requestID: 'request-rejected' }, 'failed'],
    [{ status: 408, requestID: 'request-timeout' }, 'unknown'],
    [{ status: 409, requestID: 'request-conflict' }, 'unknown'],
    [{ status: 503, requestID: 'request-unknown' }, 'unknown'],
    [new Error('network failure'), 'unknown'],
  ] as const)('APIの失敗状態を再送せず台帳へ渡す', async (error, state) => {
    const hooks = {
      begin: vi.fn(async () => 'attempt-id'),
      finish: vi.fn(async () => undefined),
    };
    create.mockReturnValue(apiRequest(Promise.reject(error)));

    await expect(
      new OpenAIScriptProvider('key').createScript(input, {
        ...options(),
        attemptHooks: hooks,
      }),
    ).rejects.toBeDefined();

    expect(hooks.finish).toHaveBeenCalledExactlyOnceWith(
      'script',
      1,
      'attempt-id',
      expect.objectContaining({
        state,
        ...('requestID' in error ? { requestId: error.requestID } : {}),
      }),
    );
    expect(create).toHaveBeenCalledOnce();
  });
  it('キーなし・許可外モデル・中断時は送信しない', async () => {
    expect(() => new OpenAIScriptProvider('')).toThrow('OPENAI_KEY_MISSING');
    const provider = new OpenAIScriptProvider('key');
    await expect(
      provider.createScript(input, {
        ...options(),
        modelProfile: { provider: 'other', modelId: 'other' },
      }),
    ).rejects.toThrow('OPENAI_MODEL_NOT_ALLOWED');
    await expect(
      provider.createScript(input, { ...options(), signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
  });
});
