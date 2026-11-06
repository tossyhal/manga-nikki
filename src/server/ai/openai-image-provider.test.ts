import { beforeEach, describe, expect, it, vi } from 'vitest';
import sampleJson from '../../../docs/contracts/script.example.json';
import { scriptSchema } from './script-schema';
import { OpenAIImageProvider, openaiImageModelProfile } from './openai-image-provider';
import { createApp } from '../app';
import { mockEnvironment } from '../mode';

const sample = scriptSchema.parse(sampleJson);
const { imageCall, generateCall, editCall, construct } = vi.hoisted(() => ({
  imageCall: vi.fn(),
  generateCall: vi.fn(),
  editCall: vi.fn(),
  construct: vi.fn(),
}));
vi.mock('openai', () => ({
  default: class {
    images = {
      generate: (...args: unknown[]) => {
        generateCall(...args);
        return { withResponse: () => imageCall(...args) };
      },
      edit: (...args: unknown[]) => {
        editCall(...args);
        return { withResponse: () => imageCall(...args) };
      },
    };
    constructor(options: unknown) {
      construct(options);
    }
  },
  toFile: async (data: Uint8Array, name: string, options: { type: string }) =>
    new File([data.slice().buffer], name, options),
}));
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12P4DwQACfsD/WMmxY8AAAAASUVORK5CYII=';
const imageResponse = () => ({
  request_id: 'request-test',
  data: {
    created: 1,
    data: [{ b64_json: png }],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  },
});
const options = () => ({
  signal: new AbortController().signal,
  generationId: crypto.randomUUID(),
  callIndex: 1,
  modelProfile: openaiImageModelProfile,
});
const env = {
  ...mockEnvironment,
  OPENAI_API_KEY: 'test-key',
  OPENAI_IMAGE_ENABLED: 'true',
  OPENAI_IMAGE_BUDGET_APPROVED: 'true',
};
const url = 'http://127.0.0.1/api/v1/dev/openai-comics';
const request = (script: unknown = sample) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Dev-OpenAI': '1' },
  body: JSON.stringify({ script }),
});
beforeEach(() => {
  vi.restoreAllMocks();
  imageCall.mockReset().mockResolvedValue(imageResponse());
  generateCall.mockReset();
  editCall.mockReset();
  construct.mockReset();
});

describe('OpenAI画像Provider', () => {
  it('最初は生成、後続は最初の画像を参照して4枚を生成する', async () => {
    const events: string[] = [];
    const hooks = {
      begin: vi.fn(async (_stage: string, callIndex: number) => {
        events.push(`begin:${callIndex}`);
        return `attempt-${callIndex}`;
      }),
      finish: vi.fn(async (_stage: string, callIndex: number, _attemptId: string, outcome) => {
        events.push(`finish:${callIndex}:${outcome.state}`);
      }),
    };
    generateCall.mockImplementation(() => events.push('generate'));
    editCall.mockImplementation(() => events.push('edit'));
    const result = await new OpenAIImageProvider('test-key').render(sample, {
      ...options(),
      attemptHooks: hooks,
    });
    expect(result.panels.map((p) => p.index)).toEqual([1, 2, 3, 4]);
    expect(result.modelId).toBe('gpt-image-2.5-flare');
    expect(construct).toHaveBeenCalledWith({
      apiKey: 'test-key',
      timeout: 120_000,
      maxRetries: 0,
      logLevel: 'off',
    });
    expect(imageCall).toHaveBeenCalledTimes(4);
    expect(events).toEqual([
      'begin:1',
      'generate',
      'finish:1:succeeded',
      'begin:2',
      'edit',
      'finish:2:succeeded',
      'begin:3',
      'edit',
      'finish:3:succeeded',
      'begin:4',
      'edit',
      'finish:4:succeeded',
    ]);
    expect(hooks.finish).toHaveBeenNthCalledWith(
      1,
      'images',
      1,
      'attempt-1',
      expect.objectContaining({
        state: 'succeeded',
        requestId: 'request-test',
        metadata: expect.objectContaining({
          stage: 'images',
          callIndex: 1,
          modelId: openaiImageModelProfile.modelId,
          requestId: 'request-test',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        }),
      }),
    );
    const calls = imageCall.mock.calls;
    expect(calls[0]![0]).not.toHaveProperty('image');
    for (const [body, config] of calls) {
      expect(body).toMatchObject({
        model: 'gpt-image-2.5-flare',
        quality: 'low',
        size: '1024x1024',
        output_format: 'png',
        n: 1,
      });
      expect(config.signal).toBeInstanceOf(AbortSignal);
    }
    for (const [body] of calls.slice(1)) {
      expect(body.image).toBeInstanceOf(File);
      expect(new Uint8Array(await body.image.arrayBuffer())).toEqual(result.panels[0].data);
    }
    expect(result.panels[0].usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });
  it('途中失敗で完了済みコマを返し、自動再送しない', async () => {
    const hooks = {
      begin: vi.fn(async (_stage: string, callIndex: number) => `attempt-${callIndex}`),
      finish: vi.fn(async () => undefined),
    };
    imageCall
      .mockReset()
      .mockResolvedValueOnce(imageResponse())
      .mockRejectedValueOnce({ status: 503 });
    await expect(
      new OpenAIImageProvider('test-key').render(sample, { ...options(), attemptHooks: hooks }),
    ).rejects.toMatchObject({
      code: 'IMAGE_RESULT_UNKNOWN',
      failedPanel: 2,
      completedPanels: [expect.objectContaining({ index: 1 })],
    });
    expect(imageCall).toHaveBeenCalledTimes(2);
    expect(hooks.finish).toHaveBeenNthCalledWith(
      2,
      'images',
      2,
      'attempt-2',
      expect.objectContaining({ state: 'unknown' }),
    );
    expect(hooks.begin).toHaveBeenCalledTimes(2);
  });
  it('台帳の開始に失敗したら画像SDK自体を呼ばず、既存結果を保持する', async () => {
    const hooks = {
      begin: vi.fn(async () => {
        throw new Error('ledger unavailable');
      }),
      finish: vi.fn(async () => undefined),
    };
    await expect(
      new OpenAIImageProvider('test-key').render(sample, { ...options(), attemptHooks: hooks }),
    ).rejects.toMatchObject({ code: 'IMAGE_RESULT_UNKNOWN', completedPanels: [] });
    expect(generateCall).not.toHaveBeenCalled();
    expect(editCall).not.toHaveBeenCalled();
    expect(imageCall).not.toHaveBeenCalled();
  });
  it.each([
    { created: 1, data: [] },
    { created: 1, data: [{ b64_json: btoa('invalid image') }] },
    { created: 1, data: [{ url: 'https://untrusted.example/image.png' }] },
    { created: 1, data: [{ b64_json: png }, { b64_json: png }] },
  ])('不正な画像出力を拒否する', async (data) => {
    const hooks = {
      begin: vi.fn(async () => 'attempt-1'),
      finish: vi.fn(async () => undefined),
    };
    imageCall.mockResolvedValue({ data, request_id: 'request-test' });
    await expect(
      new OpenAIImageProvider('test-key').render(sample, { ...options(), attemptHooks: hooks }),
    ).rejects.toMatchObject({ failedPanel: 1, completedPanels: [] });
    expect(imageCall).toHaveBeenCalledTimes(1);
    expect(hooks.finish).toHaveBeenCalledExactlyOnceWith(
      'images',
      1,
      'attempt-1',
      expect.objectContaining({ state: 'succeeded', requestId: 'request-test' }),
    );
  });
  it('キー不足、中断済み、不正脚本、許可外モデルでは送信しない', async () => {
    expect(() => new OpenAIImageProvider('')).toThrow('IMAGE_KEY_MISSING');
    const provider = new OpenAIImageProvider('test-key');
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.render(sample, { ...options(), signal: controller.signal }),
    ).rejects.toBeDefined();
    await expect(
      provider.render({ ...sample, panels: [] } as never, options()),
    ).rejects.toBeDefined();
    await expect(
      provider.render(sample, {
        ...options(),
        modelProfile: { provider: 'other', modelId: 'other' },
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_MODEL_NOT_ALLOWED' });
    expect(imageCall).not.toHaveBeenCalled();
  });
});
describe('ローカル4コマ生成API', () => {
  it('既定では外部送信しない。公開ホスト・別Origin・本番ビルド・不正入力も拒否する', async () => {
    const app = createApp({ localDevelopment: true });
    expect((await app.request(url, request(), mockEnvironment)).status).toBe(503);
    expect(
      (await app.request(url.replace('127.0.0.1', 'example.com'), request(), env)).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          url,
          { ...request(), headers: { ...request().headers, Origin: 'https://example.com' } },
          env,
        )
      ).status,
    ).toBe(404);
    expect((await createApp().request(url, request(), env)).status).toBe(404);
    expect((await app.request(url, request({}), env)).status).toBe(400);
    expect(imageCall).not.toHaveBeenCalled();
  });
  it('画像URLと縦4コマプレビューを返し、本文をHTMLとして実行しない', async () => {
    const app = createApp({ localDevelopment: true });
    const script = { ...sample, title: '<script>alert(1)</script>' };
    const response = await app.request(url, request(script), env);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.panels).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain(png);
    const image = await app.request(`http://127.0.0.1${result.panels[0].url}`, {}, env);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(image.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await image.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    const view = await app.request(`http://127.0.0.1${result.previewUrl}`, {}, env);
    const html = await view.text();
    expect(html.match(/<img\s/g)).toHaveLength(4);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain(sample.panels[0].caption);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect((await app.request(`http://127.0.0.1${result.previewUrl}`, {}, env)).status).toBe(404);
  });
  it('部分失敗でも成功した画像を取得でき、後続コマは呼び出さない', async () => {
    imageCall
      .mockReset()
      .mockResolvedValueOnce(imageResponse())
      .mockRejectedValueOnce({ status: 429 });
    const app = createApp({ localDevelopment: true });
    const response = await app.request(url, request(), env);
    expect(response.status).toBe(503);
    const result = await response.json();
    expect(result.error).toMatchObject({
      code: 'IMAGE_RATE_LIMIT',
      failedPanel: 2,
      retryable: false,
    });
    expect(result.panels).toHaveLength(1);
    expect((await app.request(`http://127.0.0.1${result.panels[0].url}`, {}, env)).status).toBe(
      200,
    );
    expect(imageCall).toHaveBeenCalledTimes(2);
  });
  it('同時実行と起動中3回目の実行を拒否する', async () => {
    let resolveFirst!: (value: ReturnType<typeof imageResponse>) => void;
    imageCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const app = createApp({ localDevelopment: true });
    const first = app.request(url, request(), env);
    await vi.waitFor(() => expect(imageCall).toHaveBeenCalledTimes(1));
    expect((await app.request(url, request(), env)).status).toBe(429);
    resolveFirst(imageResponse());
    expect((await first).status).toBe(200);
    expect((await app.request(url, request(), env)).status).toBe(200);
    expect((await app.request(url, request(), env)).status).toBe(429);
    expect(imageCall).toHaveBeenCalledTimes(8);
  });
});

describe('OpenAIの利用制限エラーの分類', () => {
  it.each([
    { status: 429, code: 'insufficient_quota' },
    { status: 429, type: 'insufficient_quota' },
    { status: 429, code: 'credit_balance_exhausted' },
    { status: 429, code: 'billing_hard_limit_reached' },
    { status: 429, error: { code: 'organization_usage_limit_exceeded' } },
    { status: 429, code: 'project_spend_limit_exceeded' },
    { status: 429, error: { type: 'project_usage_limit_exceeded' } },
    { status: 429, code: 'organization_spend_limit_exceeded' },
  ])('残高・利用額上限を頻度制限と区別する', async (error) => {
    imageCall.mockRejectedValue(error);
    await expect(
      new OpenAIImageProvider('test-key').render(sample, options()),
    ).rejects.toMatchObject({
      code: 'IMAGE_QUOTA_EXCEEDED',
      failedPanel: 1,
      completedPanels: [],
      providerStatus: 429,
    });
    expect(imageCall).toHaveBeenCalledTimes(1);
  });

  it('通常の頻度制限はIMAGE_RATE_LIMITで返す', async () => {
    const hooks = {
      begin: vi.fn(async () => 'attempt-1'),
      finish: vi.fn(async () => undefined),
    };
    imageCall.mockRejectedValue({ status: 429, code: 'rate_limit_exceeded' });
    await expect(
      new OpenAIImageProvider('test-key').render(sample, { ...options(), attemptHooks: hooks }),
    ).rejects.toMatchObject({ code: 'IMAGE_RATE_LIMIT' });
    expect(hooks.finish).toHaveBeenCalledExactlyOnceWith(
      'images',
      1,
      'attempt-1',
      expect.objectContaining({ state: 'failed' }),
    );
  });

  it.each([
    [{ status: 401, requestID: 'request-rejected' }, 'IMAGE_REQUEST_REJECTED', 'failed'],
    [{ status: 408, requestID: 'request-timeout' }, 'IMAGE_RESULT_UNKNOWN', 'unknown'],
    [{ status: 409, requestID: 'request-conflict' }, 'IMAGE_RESULT_UNKNOWN', 'unknown'],
  ] as const)('既知の拒否と結果不明を区別して再送しない', async (error, code, state) => {
    const hooks = {
      begin: vi.fn(async () => 'attempt-1'),
      finish: vi.fn(async () => undefined),
    };
    imageCall.mockRejectedValue(error);

    await expect(
      new OpenAIImageProvider('test-key').render(sample, { ...options(), attemptHooks: hooks }),
    ).rejects.toMatchObject({ code, failedPanel: 1, completedPanels: [] });

    expect(hooks.finish).toHaveBeenCalledExactlyOnceWith(
      'images',
      1,
      'attempt-1',
      expect.objectContaining({ state, requestId: error.requestID }),
    );
    expect(generateCall).toHaveBeenCalledOnce();
    expect(imageCall).toHaveBeenCalledOnce();
    expect(editCall).not.toHaveBeenCalled();
  });

  it('API経由でも残高不足を返し、生のエラー情報を出さない', async () => {
    imageCall.mockRejectedValue({
      status: 429,
      code: 'insufficient_quota',
      message: 'PRIVATE_PROVIDER_MESSAGE',
    });
    const response = await createApp({ localDevelopment: true }).request(url, request(), env);
    const result = await response.json();
    expect(response.status).toBe(503);
    expect(result.error.code).toBe('IMAGE_QUOTA_EXCEEDED');
    expect(result.panels).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_MESSAGE');
  });
});
