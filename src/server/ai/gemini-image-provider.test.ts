import { beforeEach, describe, expect, it, vi } from 'vitest';
import sampleJson from '../../../docs/contracts/script.example.json';
import { scriptSchema } from './script-schema';
const sample = scriptSchema.parse(sampleJson);
import { GeminiImageProvider, geminiImageModelProfile } from './gemini-image-provider';

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
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const imageResponse = () => ({
  candidates: [
    {
      finishReason: 'STOP',
      content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] },
    },
  ],
  responseId: 'request-test',
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
});
const options = () => ({
  signal: new AbortController().signal,
  generationId: crypto.randomUUID(),
  callIndex: 1,
  modelProfile: geminiImageModelProfile,
});
beforeEach(() => {
  vi.restoreAllMocks();
  generateContent.mockReset().mockResolvedValue(imageResponse());
  construct.mockReset();
});

describe('Gemini画像Provider', () => {
  it('カラー指定だけ配色の指示を使い、既定の白黒指定を保持する', async () => {
    await new GeminiImageProvider('test-key', 'color').render(sample, options());
    const colorPrompt = generateContent.mock.calls[0]![0].contents[0].parts[0].text;
    expect(colorPrompt).toContain('フルカラーの日本の漫画調');
    expect(colorPrompt).toContain('配色を全コマで統一');
    expect(colorPrompt).not.toContain('白黒の日本の漫画調');
    generateContent.mockClear();
    await new GeminiImageProvider('test-key').render(sample, options());
    expect(generateContent.mock.calls[0]![0].contents[0].parts[0].text).toContain(
      '白黒の日本の漫画調',
    );
    expect(generateContent.mock.calls[0]![0].contents[0].parts[0].text).not.toContain('フルカラー');
  });

  it('4枚を順に生成し、1枚目を後続の参照に使い、画像はバイト列で返す', async () => {
    const result = await new GeminiImageProvider('test-key').render(sample, options());
    expect(result.panels.map((panel) => panel.index)).toEqual([1, 2, 3, 4]);
    expect(result.panels.every((panel) => panel.data instanceof Uint8Array)).toBe(true);
    expect(generateContent).toHaveBeenCalledTimes(4);
    expect(construct).toHaveBeenCalledWith(
      expect.objectContaining({ httpOptions: { timeout: 120_000, retryOptions: { attempts: 1 } } }),
    );
    const calls = generateContent.mock.calls.map(([call]) => call);
    expect(calls[0].contents[0].parts).toHaveLength(1);
    for (const call of calls.slice(1)) expect(call.contents[0].parts[1].inlineData.data).toBe(png);
    for (const call of calls)
      expect(call.config.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
  });
  it('途中の通信失敗は再送せず、成功済み画像を保持する', async () => {
    generateContent
      .mockReset()
      .mockResolvedValueOnce(imageResponse())
      .mockRejectedValueOnce({ status: 503 });
    await expect(
      new GeminiImageProvider('test-key').render(sample, options()),
    ).rejects.toMatchObject({
      code: 'IMAGE_RESULT_UNKNOWN',
      failedPanel: 2,
      completedPanels: [expect.objectContaining({ index: 1 })],
    });
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
  it.each([
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '画像はありません' }] } }] },
    { candidates: [{ finishReason: 'SAFETY' }] },
    {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [{ inlineData: { mimeType: 'image/png', data: btoa('not a real image') } }],
          },
        },
      ],
    },
  ])('不完全な画像レスポンスを拒否する', async (response) => {
    generateContent.mockResolvedValue(response);
    await expect(
      new GeminiImageProvider('test-key').render(sample, options()),
    ).rejects.toMatchObject({ failedPanel: 1, completedPanels: [] });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
  it('中断済み・不正な脚本・許可外モデルは送信しない', async () => {
    const provider = new GeminiImageProvider('test-key');
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
        modelProfile: { provider: 'gemini', modelId: 'other' },
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_MODEL_NOT_ALLOWED' });
    expect(generateContent).not.toHaveBeenCalled();
  });
});
