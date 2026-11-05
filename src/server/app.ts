import { createDevComicRoutes } from './dev-comic';
import {
  getMockQuota,
  createMockEntry,
  listMockEntries,
  getMockEntry,
  getMockEntryDetail,
  reserveMockGeneration,
} from './repositories/mock-service';
import { Hono } from 'hono';
import { z } from 'zod';
import { MockScriptProvider, mockScriptModelProfile } from './ai/mock-script-provider';
import { createEntrySchema, updateEntrySchema, generateSchema } from '../shared/schemas';
import { resolveMode, type Environment } from './mode';
import type { RecoverGeneratedComic, SaveGeneratedComic } from './generation-save-handler';
import { createMockRepository, type MockRepository } from './repositories/mock';
import {
  createLiveEntry,
  deleteLiveEntry,
  getLiveEntryDetail,
  listLiveEntries,
  LiveEntryError,
  updateLiveEntry,
} from './live-entries';
import {
  generationIngressConfigured,
  getLiveGeneration,
  getLiveGenerationQuota,
  getLiveMockAssetUrl,
  LiveGenerationError,
  openAIGenerationIngressConfigured,
  reserveLiveOpenAIGeneration,
  reserveLiveMockGeneration,
} from './live-generations';
import {
  getBearerToken,
  InvalidAccessTokenError,
  SupabaseAuthUnavailableError,
  verifySupabaseAccessToken,
} from './auth';

import { ApiError, messages, jsonBody } from './http';

export function createApp(
  options: {
    localDevelopment?: boolean;
    repository?: MockRepository;
    authFetch?: typeof fetch;
    supabaseFetch?: typeof fetch;
    turnstileFetch?: typeof fetch;
    saveGeneratedComic?: SaveGeneratedComic;
    recoverGeneratedComic?: RecoverGeneratedComic;
  } = {},
) {
  let repository = options.repository;
  const getRepository = () => (repository ??= createMockRepository());
  const app = new Hono<{
    Bindings: Environment;
    Variables: { owner: string; accessToken: string | null };
  }>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.onError((error, c) => {
    const failure =
      error instanceof ApiError
        ? error
        : error instanceof LiveEntryError
          ? new ApiError(error.status, error.code)
          : error instanceof LiveGenerationError
            ? new ApiError(error.status, error.code)
            : error instanceof z.ZodError
              ? new ApiError(400, 'INVALID_INPUT')
              : new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
    return c.json(
      {
        error: {
          code: failure.code,
          message:
            error instanceof LiveGenerationError && error.code === 'GENERATION_DISABLED'
              ? '現在、新しい漫画の生成を利用できません。'
              : messages[failure.code],
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
      generationAvailable:
        current === 'local-mock' ||
        (current === 'local-connected' && generationIngressConfigured(c.env)) ||
        (current === 'live-demo' &&
          openAIGenerationIngressConfigured(
            c.env,
            typeof options.saveGeneratedComic === 'function',
            typeof options.recoverGeneratedComic === 'function',
          )),
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
    if (current === 'preview-sample') throw new ApiError(503, 'GENERATION_DISABLED');
    const url = new URL(c.req.url);
    const origin = c.req.header('Origin');
    if (origin && origin !== url.origin) throw new ApiError(401, 'AUTH_REQUIRED');

    let owner: string;
    let accessToken: string | null = null;
    if (current === 'local-mock') {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new ApiError(401, 'AUTH_REQUIRED');
      owner = c.req.header('Authorization')?.match(/^Bearer mock:([0-9a-f-]+)$/)?.[1] ?? '';
      if (!z.uuid().safeParse(owner).success) throw new ApiError(401, 'AUTH_REQUIRED');
    } else {
      try {
        const token = getBearerToken(c.req.header('Authorization'));
        owner = await verifySupabaseAccessToken(c.env, token, options.authFetch);
        accessToken = token;
      } catch (error) {
        if (error instanceof InvalidAccessTokenError) throw new ApiError(401, 'AUTH_REQUIRED');
        if (error instanceof SupabaseAuthUnavailableError)
          throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
        throw error;
      }
    }
    c.set('owner', owner);
    c.set('accessToken', accessToken);
    await next();
  });
  const liveContext = (c: {
    env: Environment;
    get: (key: 'owner' | 'accessToken') => string | null;
  }) => {
    const accessToken = c.get('accessToken');
    if (!accessToken) throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
    return {
      environment: c.env,
      owner: c.get('owner') as string,
      accessToken,
      fetcher: options.supabaseFetch,
      turnstileFetch: options.turnstileFetch,
    };
  };
  app.get('/api/v1/me/quota', async (c) => {
    const current = mode(c.env);
    if (current !== 'local-mock')
      return c.json(
        await getLiveGenerationQuota(
          liveContext(c),
          (current === 'local-connected' && generationIngressConfigured(c.env)) ||
            (current === 'live-demo' &&
              openAIGenerationIngressConfigured(
                c.env,
                typeof options.saveGeneratedComic === 'function',
                typeof options.recoverGeneratedComic === 'function',
              )),
          current !== 'live-demo',
        ),
      );
    return c.json(getMockQuota(getRepository(), c.get('owner')));
  });
  app.post('/api/v1/entries', async (c) => {
    const input = createEntrySchema.parse(await jsonBody(c.req.raw));
    if (mode(c.env) !== 'local-mock')
      return c.json(await createLiveEntry(liveContext(c), input), 201);
    return c.json(createMockEntry(getRepository(), c.get('owner'), input), 201);
  });
  app.get('/api/v1/entries', async (c) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(c.req.query('limit') ?? 20);
    if (mode(c.env) !== 'local-mock') {
      const cursor = c.req.query('cursor');
      return c.json(
        await listLiveEntries(liveContext(c), { limit, ...(cursor ? { cursor } : {}) }),
      );
    }
    return c.json(listMockEntries(getRepository(), c.get('owner'), limit, c.req.query('cursor')));
  });
  app.get('/api/v1/entries/:id', async (c) => {
    if (mode(c.env) !== 'local-mock') {
      const detail = await getLiveEntryDetail(liveContext(c), c.req.param('id'));
      if (!detail) throw new ApiError(404, 'NOT_FOUND');
      return c.json(detail);
    }
    return c.json(getMockEntryDetail(getRepository(), c.req.param('id'), c.get('owner')));
  });
  app.patch('/api/v1/entries/:id', async (c) => {
    const input = updateEntrySchema.parse(await jsonBody(c.req.raw));
    if (mode(c.env) !== 'local-mock')
      return c.json(await updateLiveEntry(liveContext(c), c.req.param('id'), input));
    const { entry } = getMockEntry(getRepository(), c.req.param('id'), c.get('owner'));
    if (input.expectedRevision !== entry.revision) throw new ApiError(409, 'REVISION_CONFLICT');
    Object.assign(entry, {
      body: input.body,
      diaryDate: input.diaryDate,
      revision: entry.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    return c.json(entry);
  });
  app.delete('/api/v1/entries/:id', async (c) => {
    if (mode(c.env) !== 'local-mock')
      return c.json(await deleteLiveEntry(liveContext(c), c.req.param('id')), 202);
    const { entry } = getMockEntry(getRepository(), c.req.param('id'), c.get('owner'));
    getRepository().entries.delete(entry.id);
    for (const [key, job] of getRepository().generations)
      if (job.generation.entryId === entry.id) getRepository().generations.delete(key);
    return c.json({ deletionAccepted: true }, 202);
  });
  app.post('/api/v1/entries/:id/generations', async (c) => {
    const current = mode(c.env);
    const input = generateSchema.parse(await jsonBody(c.req.raw));
    if (current !== 'local-mock') {
      const context = { ...liveContext(c), turnstileFetch: options.turnstileFetch };
      const request = {
        entryId: z.uuid().parse(c.req.param('id')),
        expectedRevision: input.expectedRevision,
        idempotencyKey: z.uuid().parse(c.req.header('Idempotency-Key')),
        captchaToken: input.captchaToken,
      };
      const receipt =
        current === 'live-demo'
          ? await reserveLiveOpenAIGeneration(
              context,
              request,
              typeof options.saveGeneratedComic === 'function',
              typeof options.recoverGeneratedComic === 'function',
            )
          : await reserveLiveMockGeneration(context, request);
      return c.json(receipt, 202);
    }
    const { entry } = getMockEntry(getRepository(), c.req.param('id'), c.get('owner'));
    const key = z.uuid().parse(c.req.header('Idempotency-Key'));
    return c.json(reserveMockGeneration(getRepository(), c.get('owner'), entry, key, input), 202);
  });
  app.get('/api/v1/generations/:id', async (c) => {
    const current = mode(c.env);
    if (current !== 'local-mock') {
      const generation = await getLiveGeneration(liveContext(c), c.req.param('id'));
      if (!generation) throw new ApiError(404, 'NOT_FOUND');
      return c.json(generation);
    }
    const job = getRepository().generations.get(c.req.param('id'));
    if (!job || job.owner !== c.get('owner')) throw new ApiError(404, 'NOT_FOUND');
    return c.json(job.generation);
  });
  app.get('/api/v1/assets/:id/url', async (c) => {
    const current = mode(c.env);
    if (current === 'local-connected') {
      const asset = await getLiveMockAssetUrl(liveContext(c), c.req.param('id'));
      if (!asset) throw new ApiError(404, 'NOT_FOUND');
      return c.json(asset);
    }
    if (current !== 'local-mock') throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE');
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
