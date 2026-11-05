import { renderComicPreview } from '../comic-preview.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createEntrySchema } from '../../shared/schemas.ts';
import { scriptSchema } from './script-schema.ts';
import {
  type GeminiDiagnostics,
  GeminiScriptError,
  GeminiScriptProvider,
  geminiScriptModelProfile,
} from './gemini-script-provider.ts';
import { GeminiImageProvider, geminiImageModelProfile } from './gemini-image-provider.ts';
import { ImageGenerationError } from './image-data.ts';
import type { ScriptProvider, ScriptResult } from './script-provider.ts';
import type { ImageProvider, RenderedPanel } from './image-provider.ts';

type PanelFile = Omit<RenderedPanel, 'data'> & { file: string };
type RunResult = {
  generationId: string;
  status: 'running' | 'succeeded' | 'failed';
  stage: 'script' | 'images' | 'save';
  diaryDate: string;
  scriptModelId: string;
  imageModelId: string;
  colorMode: 'monochrome' | 'color';
  scriptFile?: string;
  previewFile?: string;
  panels: PanelFile[];
  error?: {
    code: string;
    failedPanel?: number;
    retryable: false;
    diagnostics?: GeminiDiagnostics;
    providerStatus?: number;
  };
};
// ローカルCLI専用。Worker/公開APIからは呼ばない。保存先は新規ディレクトリに限定する。
export async function generateGeminiComic(
  input: {
    body: string;
    diaryDate: string;
    outputDirectory: string;
    apiKey: string;
    colorMode?: 'monochrome' | 'color';
    signal: AbortSignal;
  },
  providers?: { script: ScriptProvider; image: ImageProvider },
): Promise<RunResult> {
  const diary = createEntrySchema
    .pick({ body: true, diaryDate: true })
    .parse({ body: input.body, diaryDate: input.diaryDate });
  input.signal.throwIfAborted();
  if (!input.apiKey.trim()) throw new Error('GEMINI_KEY_MISSING');
  // SDKの初期化と出力先の確保は、外部送信より前に完了させる。
  const scriptProvider = providers?.script ?? new GeminiScriptProvider(input.apiKey);
  const imageProvider = providers?.image ?? new GeminiImageProvider(input.apiKey, input.colorMode);
  await mkdir(dirname(input.outputDirectory), { recursive: true });
  await mkdir(input.outputDirectory);
  const generationId = crypto.randomUUID();
  const result: RunResult = {
    generationId,
    status: 'running',
    stage: 'script',
    diaryDate: diary.diaryDate,
    scriptModelId: geminiScriptModelProfile.modelId,
    imageModelId: geminiImageModelProfile.modelId,
    colorMode: input.colorMode ?? 'monochrome',
    panels: [],
  };
  const saveResult = () =>
    writeFile(
      join(input.outputDirectory, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
      'utf8',
    );
  await saveResult();
  let script: ScriptResult | undefined;
  let images: RenderedPanel[] = [];
  try {
    script = scriptSchema.parse(
      await scriptProvider.createScript(
        { id: crypto.randomUUID(), revision: 1, ...diary },
        {
          signal: input.signal,
          generationId,
          callIndex: 1,
          modelProfile: geminiScriptModelProfile,
        },
      ),
    );
    result.stage = 'save';
    await writeFile(
      join(input.outputDirectory, 'script.json'),
      JSON.stringify(script, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx' },
    );
    result.scriptFile = 'script.json';
    result.stage = 'images';
    await saveResult();
    images = (
      await imageProvider.render(script, {
        signal: input.signal,
        generationId,
        callIndex: 1,
        modelProfile: geminiImageModelProfile,
      })
    ).panels;
    result.status = 'succeeded';
  } catch (error) {
    result.status = 'failed';
    result.error = { code: 'LOCAL_GENERATION_FAILED', retryable: false };
    if (error instanceof GeminiScriptError) {
      result.error.code = error.code;
      result.error.diagnostics = error.diagnostics;
    }
    if (error instanceof ImageGenerationError) {
      images = error.completedPanels;
      result.error.code = error.code;
      result.error.failedPanel = error.failedPanel;
      result.error.providerStatus = error.providerStatus;
    }
  }
  // 保存失敗ではAIを再度呼び出さない。可能な限り成功済み画像と脚本を回収する。
  try {
    const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    for (const image of images) {
      const file = `panel-${image.index}.${extensions[image.mediaType]}`;
      await writeFile(join(input.outputDirectory, file), image.data, { flag: 'wx' });
      result.panels.push({
        index: image.index,
        mediaType: image.mediaType,
        requestId: image.requestId,
        usage: image.usage,
        file,
      });
    }
    if (script) {
      await writeFile(
        join(input.outputDirectory, 'index.html'),
        renderComicPreview({
          script,
          images: result.panels.map((panel) => ({ index: panel.index, url: panel.file })),
          notice:
            result.status === 'succeeded'
              ? 'ローカル実生成プレビュー。'
              : 'ローカル実生成プレビュー。一部の生成に失敗しています。',
        }),
        { encoding: 'utf8', flag: 'wx' },
      );
      result.previewFile = 'index.html';
    }
  } catch {
    result.status = 'failed';
    result.stage = 'save';
    result.error = { code: 'LOCAL_SAVE_FAILED', retryable: false };
  }
  await saveResult();
  return result;
}
