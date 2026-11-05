import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sample from '../../../docs/contracts/script.example.json';
import { generateGeminiComic } from './gemini-comic-runner';
import { geminiScriptModelProfile } from './gemini-script-provider';
import { geminiImageModelProfile } from './gemini-image-provider';

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const image = () => ({
  candidates: [
    {
      finishReason: 'STOP',
      content: { parts: [{ inlineData: { data: png, mimeType: 'image/png' } }] },
    },
  ],
  responseId: 'test-request',
});
const script = () => ({ candidates: [{ finishReason: 'STOP' }], text: JSON.stringify(sample) });
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gemini-comic-test-'));
  generateContent.mockReset().mockResolvedValue(image()).mockResolvedValueOnce(script());
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const input = () => ({
  body: '架空の日記。図書館に行った。',
  diaryDate: '2026-10-29',
  outputDirectory: join(directory, 'new-run'),
  apiKey: 'fake-key',
  signal: new AbortController().signal,
});

describe('Geminiのみの日記→脚本→漫画のローカル処理', () => {
  it('脚本1回と画像4回をGeminiで生成し、脚本・画像・HTMLを保存する', async () => {
    const args = input();
    const result = await generateGeminiComic(args);
    expect(result.status).toBe('succeeded');
    expect(result.panels).toHaveLength(4);
    expect(generateContent.mock.calls.map(([call]) => call.model)).toEqual([
      geminiScriptModelProfile.modelId,
      ...Array(4).fill(geminiImageModelProfile.modelId),
    ]);
    expect(JSON.parse(generateContent.mock.calls[0]![0].contents).diary).toBe(args.body);
    expect(generateContent.mock.calls[1]![0].contents[0].parts[0].text).toContain(
      sample.panels[0]!.scene,
    );
    expect(JSON.parse(await readFile(join(args.outputDirectory, 'script.json'), 'utf8'))).toEqual(
      sample,
    );
    expect((await readFile(join(args.outputDirectory, 'panel-1.png'))).subarray(0, 4)).toEqual(
      Buffer.from([137, 80, 78, 71]),
    );
    const html = await readFile(join(args.outputDirectory, 'index.html'), 'utf8');
    expect(html.match(/<img\s/g)).toHaveLength(4);
    expect(html).toContain(sample.panels[3]!.caption);
    const manifest = await readFile(join(args.outputDirectory, 'result.json'), 'utf8');
    expect(JSON.parse(manifest).status).toBe('succeeded');
    expect(manifest).not.toContain(png);
    expect(manifest).not.toContain(args.apiKey);
    expect(manifest).not.toContain(args.body);
  });
  it('画像生成の途中失敗でも脚本と完成画像を保存し、自動再送しない', async () => {
    generateContent
      .mockReset()
      .mockResolvedValueOnce(script())
      .mockResolvedValueOnce(image())
      .mockRejectedValueOnce({ status: 503, message: 'secret provider detail' });
    const args = input();
    const result = await generateGeminiComic(args);
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      code: 'IMAGE_RESULT_UNKNOWN',
      failedPanel: 2,
      retryable: false,
    });
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(await readdir(args.outputDirectory)).toEqual(
      expect.arrayContaining(['script.json', 'panel-1.png', 'index.html', 'result.json']),
    );
    const html = await readFile(join(args.outputDirectory, 'index.html'), 'utf8');
    expect(html.match(/<img\s/g)).toHaveLength(1);
    expect(html).toContain('画像未生成');
    expect(await readFile(join(args.outputDirectory, 'result.json'), 'utf8')).not.toContain(
      'secret provider detail',
    );
  });
  it('脚本が不正なら画像生成に進まない', async () => {
    generateContent
      .mockReset()
      .mockResolvedValue(image())
      .mockResolvedValueOnce({
        candidates: [{ finishReason: 'STOP' }],
        text: '{"title":"invalid"}',
      });
    const result = await generateGeminiComic(input());
    expect(result.error?.code).toBe('GEMINI_INVALID_SCRIPT');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.panels).toHaveLength(0);
  });
  it('脚本拒否の安全な診断情報を保存し、生エラーやキーは記録しない', async () => {
    generateContent.mockReset().mockRejectedValueOnce({
      status: 403,
      message: JSON.stringify({
        error: { status: 'PERMISSION_DENIED', message: 'secret-key raw diary details' },
      }),
    });
    const args = input();
    const result = await generateGeminiComic(args);
    expect(result.error).toMatchObject({
      code: 'GEMINI_REQUEST_REJECTED',
      diagnostics: { providerStatus: 403, apiStatus: 'PERMISSION_DENIED', reason: 'http_error' },
    });
    const saved = await readFile(join(args.outputDirectory, 'result.json'), 'utf8');
    expect(JSON.parse(saved).error.diagnostics.providerStatus).toBe(403);
    expect(saved).not.toContain('secret-key');
    expect(saved).not.toContain('raw diary details');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
  it('既存の保存先への再実行は送信前に拒否する', async () => {
    const args = input();
    await generateGeminiComic(args);
    generateContent.mockClear();
    await expect(generateGeminiComic(args)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(generateContent).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(args.outputDirectory, 'result.json'), 'utf8')).status,
    ).toBe('succeeded');
  });
  it('入力・キー・中断を送信前に確認する', async () => {
    await expect(generateGeminiComic({ ...input(), body: ' ' })).rejects.toBeDefined();
    await expect(generateGeminiComic({ ...input(), apiKey: '' })).rejects.toBeDefined();
    await expect(
      generateGeminiComic({ ...input(), signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
    expect(generateContent).not.toHaveBeenCalled();
    expect(await readdir(directory)).toHaveLength(0);
  });
  it('脚本由来のHTMLと外部URLを実行可能な要素にしない', async () => {
    const hostile = structuredClone(sample);
    hostile.title = '<script>alert(1)</script>';
    hostile.panels[0]!.caption = '<img src=x onerror=alert(1)>';
    generateContent
      .mockReset()
      .mockResolvedValue(image())
      .mockResolvedValueOnce({
        candidates: [{ finishReason: 'STOP' }],
        text: JSON.stringify(hostile),
      });
    const args = input();
    await generateGeminiComic(args);
    const html = await readFile(join(args.outputDirectory, 'index.html'), 'utf8');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x');
  });
  it('CLIの入力確認はキーなしで動き、出力フォルダを作成しない', async () => {
    const output = join(directory, 'cli-dry-run');
    const result = await promisify(execFile)(process.execPath, [
      '--experimental-transform-types',
      'scripts/generate-comic-gemini.ts',
      'docs/contracts/script.example.txt',
      output,
      '--date',
      '2026-10-29',
    ]);
    expect(result.stdout).toContain('API送信・ファイル作成はしていません');
    expect(await readdir(directory)).toHaveLength(0);
  });
  it('CLIでフラグ未設定なら実生成も送信前に停止する', async () => {
    const output = join(directory, 'cli-disabled');
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          '--experimental-transform-types',
          'scripts/generate-comic-gemini.ts',
          'docs/contracts/script.example.txt',
          output,
          '--generate',
        ],
        {
          env: {
            ...process.env,
            GEMINI_API_KEY: 'fake',
            GEMINI_SCRIPT_ENABLED: 'false',
            GEMINI_IMAGE_ENABLED: 'false',
            GEMINI_IMAGE_BUDGET_APPROVED: 'false',
          },
        },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('未有効か予算が未確認') });
    expect(await readdir(directory)).toHaveLength(0);
  });
});
