import { Hono } from 'hono';
import { z } from 'zod';
import { pageComic } from '../shared/fixtures';
import { createEntrySchema, updateEntrySchema, generateSchema, jstToday } from '../shared/schemas';
import { resolveMode, type Environment } from './mode';
import { createMockRepository, type MockRepository } from './repositories/mock';
import {
  getBearerToken,
  InvalidAccessTokenError,
  SupabaseAuthUnavailableError,
  verifySupabaseAccessToken,
} from './auth';

class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409 | 413 | 429 | 503,
    public code: string,
  ) {
    super(code);
  }
}
const messages: Record<string, string> = {
  INVALID_INPUT: '入力内容を確認してください。',
  AUTH_REQUIRED: '認証情報を確認してください。',
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
  options: {
    localDevelopment?: boolean;
    repository?: MockRepository;
    authFetch?: typeof fetch;
  } = {},
) {
  let repository = options.repository;
  const getRepository = () => (repository ??= createMockRepository());
  const app = new Hono<{ Bindings: Environment; Variables: { owner: string } }>();
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
  app.use('/api/v1/*', async (c, next) => {
    const current = mode(c.env);
    if (current === 'preview-sample') throw new ApiError(503, 'GENERATION_DISABLED');
    const url = new URL(c.req.url);
    const origin = c.req.header('Origin');
    if (origin && origin !== url.origin) throw new ApiError(401, 'AUTH_REQUIRED');

    let owner: string;
    if (current === 'local-mock') {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new ApiError(401, 'AUTH_REQUIRED');
      owner = c.req.header('Authorization')?.match(/^Bearer mock:([0-9a-f-]+)$/)?.[1] ?? '';
      if (!z.uuid().safeParse(owner).success) throw new ApiError(401, 'AUTH_REQUIRED');
    } else {
      try {
        const token = getBearerToken(c.req.header('Authorization'));
        owner = await verifySupabaseAccessToken(c.env, token, options.authFetch);
      } catch (error) {
        if (error instanceof InvalidAccessTokenError) throw new ApiError(401, 'AUTH_REQUIRED');
        if (error instanceof SupabaseAuthUnavailableError)
          throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
        throw error;
      }
    }
    c.set('owner', owner);
    await next();
  });
  app.use('/api/v1/*', async (c, next) => {
    if (mode(c.env) !== 'local-mock') throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
    await next();
  });
  const getEntry = (id: string, owner: string) => {
    const found = getRepository().entries.get(id);
    if (!found || found.owner !== owner) throw new ApiError(404, 'NOT_FOUND');
    return found;
  };
  app.get('/api/v1/me/quota', (c) => {
    const day = jstToday();
    const resetAt = new Date(Date.parse(`${day}T00:00:00+09:00`) + 86400000).toISOString();
    return c.json({
      remainingToday: Math.max(
        0,
        2 - (getRepository().counts.get(`${c.get('owner')}:${day}`) ?? 0),
      ),
      activeGenerationId: null,
      resetAt,
      generationAvailable: true,
    });
  });
  app.post('/api/v1/entries', async (c) => {
    const input = createEntrySchema.parse(await jsonBody(c.req.raw));
    const owner = c.get('owner');
    const existing = [...getRepository().entries.values()].find(
      (x) => x.owner === owner && x.requestId === input.createRequestId,
    );
    if (existing) {
      if (existing.entry.body !== input.body || existing.entry.diaryDate !== input.diaryDate)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
      return c.json(existing.entry, 201);
    }
    if (
      [...getRepository().entries.values()].filter(
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
    getRepository().entries.set(entry.id, { owner, requestId: input.createRequestId, entry });
    return c.json(entry, 201);
  });
  app.get('/api/v1/entries', (c) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(c.req.query('limit') ?? 20);
    const sorted = [...getRepository().entries.values()]
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
        ? (getRepository().generations.get(entry.latestGenerationId)?.generation ?? null)
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
    getRepository().entries.delete(entry.id);
    for (const [key, job] of getRepository().generations)
      if (job.generation.entryId === entry.id) getRepository().generations.delete(key);
    return c.json({ deletionAccepted: true }, 202);
  });
  app.post('/api/v1/entries/:id/generations', async (c) => {
    const input = generateSchema.parse(await jsonBody(c.req.raw));
    const { entry } = getEntry(c.req.param('id'), c.get('owner'));
    const key = z.uuid().parse(c.req.header('Idempotency-Key'));
    const owner = c.get('owner');
    const old = [...getRepository().generations.values()].find(
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
    const count = getRepository().counts.get(counter) ?? 0;
    if (count >= 2) throw new ApiError(429, 'USER_LIMIT_REACHED');
    const id = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const comic = {
      ...pageComic,
      visual: { kind: 'page' as const, assetId, textMode: 'external' as const },
    };
    getRepository().generations.set(id, {
      owner,
      key,
      revision: entry.revision,
      generation: { id, entryId: entry.id, status: 'succeeded', stage: null, comic, mock: true },
    });
    getRepository().counts.set(counter, count + 1);
    entry.latestGenerationId = id;
    return c.json(receipt(id), 202);
  });
  app.get('/api/v1/generations/:id', (c) => {
    const job = getRepository().generations.get(c.req.param('id'));
    if (!job || job.owner !== c.get('owner')) throw new ApiError(404, 'NOT_FOUND');
    return c.json(job.generation);
  });
  app.get('/api/v1/assets/:id/url', (c) => {
    const job = [...getRepository().generations.values()].find(
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
