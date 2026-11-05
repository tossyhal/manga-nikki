import { createDevComicRoutes } from './dev-comic';
import {
  type GeminiDiagnostics,
  GeminiScriptError,
  GeminiScriptProvider,
  geminiScriptModelProfile,
} from './ai/gemini-script-provider';
import { Hono } from 'hono';
import { z } from 'zod';
import { MockScriptProvider, mockScriptModelProfile } from './ai/mock-script-provider';
import { pageComic } from '../shared/fixtures';
import { createEntrySchema, updateEntrySchema, generateSchema, jstToday } from '../shared/schemas';
import { resolveMode, type Environment } from './mode';
import { createMockRepository, type MockRepository } from './repositories/mock';

class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 413 | 429 | 503,
    public code: string,
    public diagnostics?: GeminiDiagnostics,
  ) {
    super(code);
  }
}
const messages: Record<string, string> = {
  GEMINI_SERVICE_UNAVAILABLE:
    'Gemini側がサーバーエラーを返しました。diagnosticsのHTTPステータスを確認してください。',
  GEMINI_TIMEOUT:
    'Geminiの応答待ちがタイムアウトしました。実行状況を確認してから再操作してください。',
  GEMINI_ABORTED: 'Geminiの応答待ちが中断されました。実行状況を確認してください。',
  GEMINI_NETWORK_ERROR:
    'Geminiとの通信でエラーになりました。実行状況とネットワークを確認してください。',
  GEMINI_RATE_LIMIT: 'Geminiの利用上限に達しました。AI Studioで上限を確認してください。',
  GEMINI_REQUEST_REJECTED: 'Geminiのキー、モデルの利用権限、リクエスト設定を確認してください。',
  GEMINI_RESULT_UNKNOWN:
    '送信後の結果を確認できません。自動再送せず、AI Studioで利用状況を確認してください。',
  GEMINI_LOCAL_LIMIT: 'ローカル検証は同時1件、サーバー起動中5試行までです。',
  INVALID_INPUT: '入力内容を確認してください。',
  AUTH_REQUIRED: '開発用セッションを確認してください。',
  NOT_FOUND: '記録が見つかりません。',
  REVISION_CONFLICT: '記録が更新されています。再読み込みしてください。',
  IDEMPOTENCY_CONFLICT: '同じ操作IDで異なる内容は送信できません。',
  INPUT_TOO_LARGE: '入力サイズが大きすぎます。',
  USER_LIMIT_REACHED: 'モックの本日の生成上限に達しました。',
  DRAFT_LIMIT_REACHED: '下書きが上限に達しました。不要な記録を削除してください。',
  DEPENDENCY_UNAVAILABLE: 'この接続方式は初期基盤では未対応です。',
  GENERATION_DISABLED: 'この環境では個人データの操作は利用できません。',
};
async function jsonBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    throw new ApiError(400, 'INVALID_INPUT');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_INPUT');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new ApiError(413, 'INPUT_TOO_LARGE');
      }
      chunks.push(part.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_INPUT');
  } finally {
    reader.releaseLock();
  }
}
export function createApp(
  options: { localDevelopment?: boolean; repository?: MockRepository } = {},
) {
  const repository = options.repository ?? createMockRepository();
  type Bindings = Environment & { GEMINI_API_KEY?: string; GEMINI_SCRIPT_ENABLED?: string };
  const app = new Hono<{ Bindings: Bindings; Variables: { owner: string } }>();
  let geminiBusy = false;
  let geminiAttempts = 0;
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.onError((error, c) => {
    const failure =
      error instanceof ApiError
        ? error
        : error instanceof z.ZodError
          ? new ApiError(400, 'INVALID_INPUT')
          : new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
    return c.json(
      {
        error: {
          code: failure.code,
          message: messages[failure.code],
          requestId: crypto.randomUUID(),
          retryable: false,
          ...(options.localDevelopment && failure.diagnostics
            ? { diagnostics: failure.diagnostics }
            : {}),
        },
      },
      failure.status,
    );
  });
  const mode = (env: Environment) => {
    try {
      return resolveMode(env, options.localDevelopment ?? false);
    } catch {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
    }
  };
  app.get('/api/v1/health', (c) => {
    mode(c.env);
    return c.json({ status: 'ok', version: '0.1.0' });
  });
  app.get('/api/v1/config', (c) => {
    const current = mode(c.env);
    return c.json({
      generationAvailable: current === 'local-mock',
      dataMode:
        current === 'preview-sample' ? 'sample' : current === 'local-mock' ? 'mock' : 'live',
      consentVersion: 'v1',
      retentionDays: 30,
    });
  });
  app.route(
    '/api/v1/dev/openai-comics',
    createDevComicRoutes({
      localDevelopment: options.localDevelopment ?? false,
      readJson: jsonBody,
    }),
  );

  app.route(
    '/api/v1/dev/openai-color-comics',
    createDevComicRoutes({
      localDevelopment: options.localDevelopment ?? false,
      readJson: jsonBody,
      color: true,
    }),
  );

  // 実AIの比較実験専用。公開生成のモード・Queue・利用枠とは分離する。
  app.post('/api/v1/dev/gemini-script', async (c) => {
    const url = new URL(c.req.url);
    if (!options.localDevelopment || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new ApiError(404, 'NOT_FOUND');
    if (mode(c.env) !== 'local-mock') throw new ApiError(404, 'NOT_FOUND');
    const origin = c.req.header('Origin');
    if (origin && origin !== url.origin) throw new ApiError(404, 'NOT_FOUND');
    if (c.env.GEMINI_SCRIPT_ENABLED !== 'true') throw new ApiError(503, 'GENERATION_DISABLED');
    // カスタムヘッダーを要求し、他サイトの単純なフォーム送信を受け付けない。
    if (c.req.header('X-Dev-Gemini') !== '1') throw new ApiError(400, 'INVALID_INPUT');
    const input = z
      .strictObject({
        body: createEntrySchema.shape.body,
        diaryDate: createEntrySchema.shape.diaryDate,
      })
      .parse(await jsonBody(c.req.raw));
    if (!c.env.GEMINI_API_KEY?.trim()) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
    if (geminiBusy || geminiAttempts >= 5) throw new ApiError(429, 'GEMINI_LOCAL_LIMIT');
    geminiBusy = true;
    geminiAttempts += 1;
    try {
      const script = await new GeminiScriptProvider(c.env.GEMINI_API_KEY).createScript(
        { id: crypto.randomUUID(), ...input, revision: 1 },
        {
          signal: c.req.raw.signal,
          generationId: crypto.randomUUID(),
          callIndex: 1,
          modelProfile: geminiScriptModelProfile,
        },
      );
      return c.json({ mock: false, modelId: geminiScriptModelProfile.modelId, script });
    } catch (error) {
      if (error instanceof GeminiScriptError && error.code in messages) {
        throw new ApiError(
          error.code === 'GEMINI_RATE_LIMIT' ? 429 : 503,
          error.code,
          error.diagnostics,
        );
      }
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
    } finally {
      geminiBusy = false;
    }
  });
  // 固定サンプル専用。個人データAPIの認証とは分離してブラウザで確認する。
  app.get('/api/v1/dev/script', async (c) => {
    const url = new URL(c.req.url);
    if (!options.localDevelopment || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new ApiError(404, 'NOT_FOUND');
    if (mode(c.env) !== 'local-mock') throw new ApiError(404, 'NOT_FOUND');
    const origin = c.req.header('Origin');
    if (origin && origin !== url.origin) throw new ApiError(404, 'NOT_FOUND');

    const provider = new MockScriptProvider();
    const script = await provider.createScript(
      {
        id: '11111111-1111-4111-8111-111111111111',
        diaryDate: '2026-10-29',
        body: 'モック動作確認用の架空日記。',
        revision: 1,
      },
      {
        signal: c.req.raw.signal,
        generationId: crypto.randomUUID(),
        callIndex: 1,
        modelProfile: mockScriptModelProfile,
      },
    );
    return c.json({ mock: true, script });
  });
  app.use('/api/v1/*', async (c, next) => {
    const current = mode(c.env);
    if (current !== 'local-mock')
      throw new ApiError(
        503,
        current === 'preview-sample' ? 'GENERATION_DISABLED' : 'DEPENDENCY_UNAVAILABLE',
      );
    const url = new URL(c.req.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new ApiError(401, 'AUTH_REQUIRED');
    const origin = c.req.header('Origin');
    if (origin && origin !== url.origin) throw new ApiError(401, 'AUTH_REQUIRED');
    const owner = c.req.header('Authorization')?.match(/^Bearer mock:([0-9a-f-]+)$/)?.[1];
    if (!owner || !z.uuid().safeParse(owner).success) throw new ApiError(401, 'AUTH_REQUIRED');
    c.set('owner', owner);
    await next();
  });
  const getEntry = (id: string, owner: string) => {
    const found = repository.entries.get(id);
    if (!found || found.owner !== owner) throw new ApiError(404, 'NOT_FOUND');
    return found;
  };
  app.get('/api/v1/me/quota', (c) => {
    const day = jstToday();
    const resetAt = new Date(Date.parse(`${day}T00:00:00+09:00`) + 86400000).toISOString();
    return c.json({
      remainingToday: Math.max(0, 2 - (repository.counts.get(`${c.get('owner')}:${day}`) ?? 0)),
      activeGenerationId: null,
      resetAt,
      generationAvailable: true,
    });
  });
  app.post('/api/v1/entries', async (c) => {
    const input = createEntrySchema.parse(await jsonBody(c.req.raw));
    const owner = c.get('owner');
    const existing = [...repository.entries.values()].find(
      (x) => x.owner === owner && x.requestId === input.createRequestId,
    );
    if (existing) {
      if (existing.entry.body !== input.body || existing.entry.diaryDate !== input.diaryDate)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
      return c.json(existing.entry, 201);
    }
    if (
      [...repository.entries.values()].filter(
        (x) => x.owner === owner && !x.entry.latestGenerationId,
      ).length >= 20
    )
      throw new ApiError(429, 'DRAFT_LIMIT_REACHED');
    const now = new Date().toISOString();
    const entry = {
      id: crypto.randomUUID(),
      diaryDate: input.diaryDate,
      body: input.body,
      revision: 1,
      latestGenerationId: null,
      createdAt: now,
      updatedAt: now,
    };
    repository.entries.set(entry.id, { owner, requestId: input.createRequestId, entry });
    return c.json(entry, 201);
  });
  app.get('/api/v1/entries', (c) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(c.req.query('limit') ?? 20);
    const sorted = [...repository.entries.values()]
      .filter((x) => x.owner === c.get('owner'))
      .map((x) => x.entry)
      .sort((a, b) => b.diaryDate.localeCompare(a.diaryDate) || b.id.localeCompare(a.id));
    const cursor = c.req.query('cursor');
    const index = cursor ? sorted.findIndex((x) => x.id === cursor) : -1;
    if (cursor && index < 0) throw new ApiError(400, 'INVALID_INPUT');
    const items = sorted.slice(index + 1, index + 1 + limit);
    return c.json({
      items,
      nextCursor: sorted.length > index + 1 + limit ? (items.at(-1)?.id ?? null) : null,
    });
  });
  app.get('/api/v1/entries/:id', (c) => {
    const { entry } = getEntry(c.req.param('id'), c.get('owner'));
    return c.json({
      ...entry,
      latestGeneration: entry.latestGenerationId
        ? (repository.generations.get(entry.latestGenerationId)?.generation ?? null)
        : null,
    });
  });
  app.patch('/api/v1/entries/:id', async (c) => {
    const input = updateEntrySchema.parse(await jsonBody(c.req.raw));
    const { entry } = getEntry(c.req.param('id'), c.get('owner'));
    if (input.expectedRevision !== entry.revision) throw new ApiError(409, 'REVISION_CONFLICT');
    Object.assign(entry, {
      body: input.body,
      diaryDate: input.diaryDate,
      revision: entry.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return c.json(entry);
  });
  app.delete('/api/v1/entries/:id', (c) => {
    const { entry } = getEntry(c.req.param('id'), c.get('owner'));
    repository.entries.delete(entry.id);
    for (const [key, job] of repository.generations)
      if (job.generation.entryId === entry.id) repository.generations.delete(key);
    return c.json({ deletionAccepted: true }, 202);
  });
  app.post('/api/v1/entries/:id/generations', async (c) => {
    const input = generateSchema.parse(await jsonBody(c.req.raw));
    const { entry } = getEntry(c.req.param('id'), c.get('owner'));
    const key = z.uuid().parse(c.req.header('Idempotency-Key'));
    const owner = c.get('owner');
    const old = [...repository.generations.values()].find(
      (x) => x.owner === owner && x.key === key,
    );
    if (old && (old.generation.entryId !== entry.id || old.revision !== input.expectedRevision))
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
    if (!old && input.expectedRevision !== entry.revision)
      throw new ApiError(409, 'REVISION_CONFLICT');
    const receipt = (id: string) => ({
      generationId: id,
      status: 'queued' as const,
      statusUrl: `/api/v1/generations/${id}`,
    });
    if (old) return c.json(receipt(old.generation.id), 202);
    const counter = `${owner}:${jstToday()}`;
    const count = repository.counts.get(counter) ?? 0;
    if (count >= 2) throw new ApiError(429, 'USER_LIMIT_REACHED');
    const id = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const comic = {
      ...pageComic,
      visual: { kind: 'page' as const, assetId, textMode: 'external' as const },
    };
    repository.generations.set(id, {
      owner,
      key,
      revision: entry.revision,
      generation: { id, entryId: entry.id, status: 'succeeded', stage: null, comic, mock: true },
    });
    repository.counts.set(counter, count + 1);
    entry.latestGenerationId = id;
    return c.json(receipt(id), 202);
  });
  app.get('/api/v1/generations/:id', (c) => {
    const job = repository.generations.get(c.req.param('id'));
    if (!job || job.owner !== c.get('owner')) throw new ApiError(404, 'NOT_FOUND');
    return c.json(job.generation);
  });
  app.get('/api/v1/assets/:id/url', (c) => {
    const job = [...repository.generations.values()].find(
      (x) =>
        x.owner === c.get('owner') &&
        x.generation.status === 'succeeded' &&
        (x.generation.comic.visual.kind === 'page'
          ? x.generation.comic.visual.assetId === c.req.param('id')
          : x.generation.comic.visual.assetIds.includes(c.req.param('id'))),
    );
    if (!job) throw new ApiError(404, 'NOT_FOUND');
    return c.json({
      url: '/sample-comic.svg',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  });
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: messages.NOT_FOUND,
          requestId: crypto.randomUUID(),
          retryable: false,
        },
      },
      404,
    ),
  );
  return app;
}
