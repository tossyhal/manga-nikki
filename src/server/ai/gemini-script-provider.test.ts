import { beforeEach, describe, expect, it, vi } from 'vitest';
import sample from '../../../docs/contracts/script.example.json';
import { GeminiScriptProvider, geminiScriptModelProfile } from './gemini-script-provider';
import type { CallOptions, DiarySnapshot } from './script-provider';
import { createApp } from '../app';
import { mockEnvironment } from '../mode';

const { generateContent, construct } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  construct: vi.fn(),
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(options: unknown) {
      construct(options);
    }
  },
}));
const input: DiarySnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  diaryDate: '2026-10-29',
  body: '架空の日記。図書館で本を読んだ。',
  revision: 1,
};
const options = (): CallOptions => ({
  signal: new AbortController().signal,
  generationId: crypto.randomUUID(),
  callIndex: 1,
  modelProfile: geminiScriptModelProfile,
});

describe('Geminiローカル実験API', () => {
  const env = { ...mockEnvironment, GEMINI_API_KEY: 'test-key', GEMINI_SCRIPT_ENABLED: 'true' };
  const path = 'http://127.0.0.1/api/v1/dev/gemini-script';
  const request = (body: unknown = { body: input.body, diaryDate: input.diaryDate }) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-Gemini': '1' },
    body: JSON.stringify(body),
  });

  it('有効化したローカルAPIから検証済みの実生成結果を返す', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify(sample),
      candidates: [{ finishReason: 'STOP' }],
    });
    const response = await createApp({ localDevelopment: true }).request(path, request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      mock: false,
      modelId: geminiScriptModelProfile.modelId,
      script: sample,
    });
  });

  it('無効化、キーなし、不正入力、公開環境や外部ホストでは送信しない', async () => {
    const app = createApp({ localDevelopment: true });
    expect(
      (await app.request(path, request(), { ...env, GEMINI_SCRIPT_ENABLED: 'false' })).status,
    ).toBe(503);
    expect((await app.request(path, request(), { ...env, GEMINI_API_KEY: '' })).status).toBe(503);
    expect(
      (await app.request(path, request({ body: '', diaryDate: input.diaryDate }), env)).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          path,
          request({ body: input.body, diaryDate: input.diaryDate, model: 'other' }),
          env,
        )
      ).status,
    ).toBe(400);
    expect((await createApp().request(path, request(), env)).status).toBe(404);
    expect(
      (await app.request(path.replace('127.0.0.1', 'example.com'), request(), env)).status,
    ).toBe(404);
    expect(
      (await app.request(path, request(), { ...env, APP_ENV: 'production', DATA_MODE: 'sample' }))
        .status,
    ).toBe(404);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('別Originとカスタムヘッダーのないリクエストを拒否する', async () => {
    const app = createApp({ localDevelopment: true });
    const req = request();
    expect(
      (
        await app.request(
          path,
          { ...req, headers: { ...req.headers, Origin: 'https://example.com' } },
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(path, { ...req, headers: { 'Content-Type': 'application/json' } }, env))
        .status,
    ).toBe(400);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('失敗も5試行で停止し、生エラーを返さない', async () => {
    const app = createApp({ localDevelopment: true });
    generateContent.mockRejectedValue({ status: 429, message: 'secret-response' });
    for (let i = 0; i < 5; i += 1) {
      const response = await app.request(path, request(), env);
      expect(response.status).toBe(429);
      expect((await response.json()).error.code).toBe('GEMINI_RATE_LIMIT');
    }
    const limited = await app.request(path, request(), env);
    expect((await limited.json()).error.code).toBe('GEMINI_LOCAL_LIMIT');
    expect(generateContent).toHaveBeenCalledTimes(5);
  });

  it('処理中の同時リクエストを追加送信しない', async () => {
    const app = createApp({ localDevelopment: true });
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    generateContent.mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = app.request(path, request(), env);
    await ready;
    expect((await app.request(path, request(), env)).status).toBe(429);
    finish({ text: JSON.stringify(sample), candidates: [{ finishReason: 'STOP' }] });
    expect((await first).status).toBe(200);
    expect(generateContent).toHaveBeenCalledOnce();
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  generateContent.mockReset();
});

describe('GeminiScriptProvider', () => {
  it('日記を送り、構造化出力を検証する。自動再送を無効にする', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify(sample),
      candidates: [{ finishReason: 'STOP' }],
    });
    const result = await new GeminiScriptProvider('test-key').createScript(input, options());
    expect(result).toEqual(sample);
    expect(construct).toHaveBeenCalledWith({
      apiKey: 'test-key',
      httpOptions: { timeout: 120_000, retryOptions: { attempts: 1 } },
    });
    expect(generateContent).toHaveBeenCalledOnce();
    const request = generateContent.mock.calls[0]![0];
    expect(JSON.parse(request.contents).diary).toBe(input.body);
    expect(request.config.responseMimeType).toBe('application/json');
    expect(request.config.responseJsonSchema.properties.panels.minItems).toBe(4);
  });

  it('キーなし、未承認モデル、中断済みでは送信しない', async () => {
    expect(() => new GeminiScriptProvider('')).toThrow('GEMINI_KEY_MISSING');
    const provider = new GeminiScriptProvider('test-key');
    await expect(
      provider.createScript(input, {
        ...options(),
        modelProfile: { provider: 'gemini', modelId: 'other' },
      }),
    ).rejects.toThrow('GEMINI_MODEL_NOT_ALLOWED');
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.createScript(input, { ...options(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it.each([
    [{ text: '{}', candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'GEMINI_INCOMPLETE_OUTPUT'],
    [{ text: '', candidates: [{ finishReason: 'STOP' }] }, 'GEMINI_EMPTY_OUTPUT'],
    [{ text: 'invalid', candidates: [{ finishReason: 'STOP' }] }, 'GEMINI_INVALID_JSON'],
    [{ text: '{}', candidates: [{ finishReason: 'STOP' }] }, 'GEMINI_INVALID_SCRIPT'],
  ])('不完全・不正な返答を拒否する', async (response, code) => {
    generateContent.mockResolvedValue(response);
    await expect(
      new GeminiScriptProvider('test-key').createScript(input, options()),
    ).rejects.toThrow(code);
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it.each([
    [429, 'GEMINI_RATE_LIMIT'],
    [403, 'GEMINI_REQUEST_REJECTED'],
    [503, 'GEMINI_SERVICE_UNAVAILABLE'],
  ])('通信失敗を一般化し、再送しない', async (status, code) => {
    generateContent.mockRejectedValue({ status, message: 'secret-response' });
    await expect(
      new GeminiScriptProvider('test-key').createScript(input, options()),
    ).rejects.toThrow(code);
    expect(generateContent).toHaveBeenCalledOnce();
  });
});

describe('Geminiの安全な診断情報', () => {
  it('HTTPステータスと許可したAPI状態だけを残す', async () => {
    generateContent.mockRejectedValue({
      status: 503,
      message: JSON.stringify({
        error: {
          status: 'UNAVAILABLE',
          message: 'secret-key-and-diary',
          details: ['private-data'],
        },
      }),
    });
    const response = await createApp({ localDevelopment: true }).request(
      'http://127.0.0.1/api/v1/dev/gemini-script',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dev-Gemini': '1' },
        body: JSON.stringify({ body: input.body, diaryDate: input.diaryDate }),
      },
      { ...mockEnvironment, GEMINI_API_KEY: 'test-key', GEMINI_SCRIPT_ENABLED: 'true' },
    );
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error.code).toBe('GEMINI_SERVICE_UNAVAILABLE');
    expect(data.error.diagnostics).toEqual({
      modelId: geminiScriptModelProfile.modelId,
      providerStatus: 503,
      reason: 'http_error',
      elapsedMs: expect.any(Number),
      apiStatus: 'UNAVAILABLE',
    });
    expect(JSON.stringify(data)).not.toMatch(/secret-key|private-data|test-key/);
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it.each([
    [{ name: 'TimeoutError', message: 'private-data' }, 'GEMINI_TIMEOUT', 'timeout'],
    [{ name: 'AbortError', message: 'private-data' }, 'GEMINI_ABORTED', 'aborted'],
    [{ message: 'fetch failed: private-data' }, 'GEMINI_NETWORK_ERROR', 'network_error'],
    [{ message: '{"error":{"status":"private-data"}}' }, 'GEMINI_RESULT_UNKNOWN', 'sdk_error'],
  ])('HTTP応答のない障害を区別し、詳細を漏らさない', async (error, code, reason) => {
    generateContent.mockRejectedValue(error);
    const failed = new GeminiScriptProvider('test-key').createScript(input, options());
    await expect(failed).rejects.toMatchObject({
      code,
      diagnostics: { providerStatus: null, reason },
    });
    await failed.catch((value) => {
      expect(JSON.stringify(value)).not.toContain('private-data');
    });
    expect(generateContent).toHaveBeenCalledOnce();
  });
});
