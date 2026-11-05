import { OpenAIColorImageProvider } from './ai/openai-color-image-provider';
import { Hono } from 'hono';
import { renderComicPreview } from './comic-preview';
import { z } from 'zod';
import { scriptSchema } from './ai/script-schema';
import {
  OpenAIImageProvider,
  ImageGenerationError,
  openaiImageModelProfile,
} from './ai/openai-image-provider';
import type { RenderedPanel } from './ai/image-provider';
import type { ScriptResult } from './ai/script-provider';
import { resolveMode, type Environment } from './mode';

type Bindings = Environment & {
  OPENAI_API_KEY?: string;
  OPENAI_IMAGE_ENABLED?: string;
  OPENAI_IMAGE_BUDGET_APPROVED?: string;
};
type Preview = {
  script: ScriptResult;
  panels: RenderedPanel[];
  expiresAt: number;
  status: 'succeeded' | 'failed';
};

export function createDevComicRoutes(options: {
  localDevelopment: boolean;
  color?: boolean;
  readJson: (request: Request) => Promise<unknown>;
}) {
  const app = new Hono<{ Bindings: Bindings }>();
  const basePath = options.color ? '/api/v1/dev/openai-color-comics' : '/api/v1/dev/openai-comics';
  const Provider = options.color ? OpenAIColorImageProvider : OpenAIImageProvider;
  const previews = new Map<string, Preview>();
  let busy = false;
  let attempts = 0;

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const url = new URL(c.req.url);
    if (!options.localDevelopment || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      return c.json({ error: { code: 'NOT_FOUND' } }, 404);
    try {
      if (resolveMode(c.env, true) !== 'local-mock')
        return c.json({ error: { code: 'NOT_FOUND' } }, 404);
    } catch {
      return c.json({ error: { code: 'INVALID_MODE' } }, 503);
    }
    const origin = c.req.header('Origin');
    if (origin && origin !== url.origin) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
    for (const [id, preview] of previews) if (preview.expiresAt <= Date.now()) previews.delete(id);
    await next();
  });

  app.post('/', async (c) => {
    if (c.env.OPENAI_IMAGE_ENABLED !== 'true' || c.env.OPENAI_IMAGE_BUDGET_APPROVED !== 'true')
      return c.json(
        {
          error: {
            code: 'IMAGE_GENERATION_DISABLED',
            message: '画像生成の有効化と予算確認が必要です。',
            retryable: false,
          },
        },
        503,
      );
    if (c.req.header('X-Dev-OpenAI') !== '1')
      return c.json({ error: { code: 'INVALID_INPUT' } }, 400);
    const { script } = z
      .strictObject({ script: scriptSchema })
      .parse(await options.readJson(c.req.raw));
    if (!c.env.OPENAI_API_KEY?.trim()) return c.json({ error: { code: 'IMAGE_KEY_MISSING' } }, 503);
    if (busy || attempts >= 2)
      return c.json(
        {
          error: {
            code: 'IMAGE_LOCAL_LIMIT',
            message: '同時1件、起動中2試行までです。',
            retryable: false,
          },
        },
        429,
      );

    busy = true;
    attempts += 1;
    const id = crypto.randomUUID();
    const preview: Preview = {
      script,
      panels: [],
      expiresAt: Date.now() + 15 * 60_000,
      status: 'failed',
    };
    let failure: ImageGenerationError | undefined;
    try {
      const result = await new Provider(c.env.OPENAI_API_KEY).render(script, {
        signal: c.req.raw.signal,
        generationId: id,
        callIndex: 1,
        modelProfile: openaiImageModelProfile,
      });
      preview.panels = result.panels;
      preview.status = 'succeeded';
    } catch (error) {
      if (error instanceof ImageGenerationError) {
        preview.panels = error.completedPanels;
        failure = error;
      } else {
        failure = new ImageGenerationError('IMAGE_RESULT_UNKNOWN', 1, []);
      }
    } finally {
      busy = false;
    }
    // 期限は生成が終わった時点から数える。最大2件の一時メモリ保存。
    preview.expiresAt = Date.now() + 15 * 60_000;
    previews.set(id, preview);
    const base = `${basePath}/${id}`;
    return c.json(
      {
        mock: false,
        previewId: id,
        modelId: openaiImageModelProfile.modelId,
        status: preview.status,
        previewUrl: `${base}/view`,
        expiresAt: new Date(preview.expiresAt).toISOString(),
        panels: preview.panels.map((panel) => ({
          index: panel.index,
          url: `${base}/images/${panel.index}`,
          mediaType: panel.mediaType,
          requestId: panel.requestId,
          usage: panel.usage,
        })),
        ...(failure
          ? {
              error: {
                code: failure.code,
                failedPanel: failure.failedPanel,
                providerStatus: failure.providerStatus,
                retryable: false,
                message:
                  '生成を停止しました。完成済みのコマはプレビューで確認できます。利用状況を確認してから再操作してください。',
              },
            }
          : {}),
      },
      failure ? 503 : 200,
    );
  });

  app.get('/:id/images/:index', (c) => {
    const preview = previews.get(c.req.param('id'));
    const panel = preview?.panels.find((item) => String(item.index) === c.req.param('index'));
    if (!panel) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', panel.mediaType);
    return c.body(panel.data.slice().buffer);
  });

  app.get('/:id/view', (c) => {
    const preview = previews.get(c.req.param('id'));
    if (!preview) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    return c.html(
      renderComicPreview({
        script: preview.script,
        images: preview.panels.map((panel) => ({
          index: panel.index,
          url: `${basePath}/${c.req.param('id')}/images/${panel.index}`,
        })),
        notice: `ローカル${options.color ? 'カラー' : '白黒'}実生成プレビュー。15分で期限切れになります。${preview.status === 'failed' ? '一部の生成に失敗しています。' : ''}`,
      }),
    );
  });
  return app;
}
