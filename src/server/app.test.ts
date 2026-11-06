import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createMockRepository } from './repositories/mock';
import { generationFixtures, panelsComic } from '../shared/fixtures';
import { mockEnvironment, resolveMode } from './mode';
import { jstToday } from '../shared/schemas';

let app = createApp({ localDevelopment: true });
let owner: string;
beforeEach(() => {
  app = createApp({ localDevelopment: true });
  owner = crypto.randomUUID();
});
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
  user = owner,
) {
  return app.request(
    `http://localhost/api/v1${path}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer mock:${user}`,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    mockEnvironment,
  );
}
async function create() {
  const response = await request('/entries', 'POST', {
    createRequestId: crypto.randomUUID(),
    diaryDate: jstToday(),
    body: '図書館で本を読んだ。',
    consentVersion: 'v1',
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; revision: number };
}
describe('local mock API', () => {
  it('creates, generates, reads and deletes without external services', async () => {
    const entry = await create();
    const receipt = await request(
      `/entries/${entry.id}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: '' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(receipt.status).toBe(202);
    const detail = await (await request(`/entries/${entry.id}`)).json();
    expect(detail.latestGeneration.status).toBe('succeeded');
    expect(detail.body).toBe('図書館で本を読んだ。');
    const asset = detail.latestGeneration.comic.visual.assetId;
    expect((await request(`/assets/${asset}/url`)).status).toBe(200);
    expect((await request(`/entries/${entry.id}`, 'DELETE')).status).toBe(202);
    expect((await request(`/assets/${asset}/url`)).status).toBe(404);
    expect((await request(`/entries/${entry.id}`)).status).toBe(404);
  });
  it('keeps the generation revision fixed when the diary is edited later', async () => {
    const entry = await create();
    const generated = await request(
      `/entries/${entry.id}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: '' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(generated.status).toBe(202);

    const edited = await request(`/entries/${entry.id}`, 'PATCH', {
      expectedRevision: 1,
      diaryDate: jstToday(),
      body: '編集後の日記',
    });
    expect((await edited.json()).revision).toBe(2);

    const detail = await (await request(`/entries/${entry.id}`)).json();
    expect(detail.revision).toBe(2);
    expect(detail.latestGeneration.entryRevision).toBe(1);
  });
  it('uses the original create fingerprint after edits and retains a deleted key tombstone per owner', async () => {
    const createRequestId = crypto.randomUUID();
    const firstOwnerPayload = {
      createRequestId,
      diaryDate: jstToday(),
      body: '作成時の架空日記',
      consentVersion: 'v1',
    };
    const created = await request('/entries', 'POST', firstOwnerPayload);
    const firstEntry = (await created.json()) as { id: string; body: string; revision: number };
    expect(created.status).toBe(201);

    const edited = await request(`/entries/${firstEntry.id}`, 'PATCH', {
      expectedRevision: 1,
      diaryDate: jstToday(),
      body: '編集後の架空日記',
    });
    expect((await edited.json()).revision).toBe(2);

    const replayed = await request('/entries', 'POST', firstOwnerPayload);
    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toMatchObject({
      id: firstEntry.id,
      body: '編集後の架空日記',
      revision: 2,
    });
    expect(
      (await request('/entries', 'POST', { ...firstOwnerPayload, body: '別の作成内容' })).status,
    ).toBe(409);

    const secondOwner = crypto.randomUUID();
    const secondEntryResponse = await request(
      '/entries',
      'POST',
      { ...firstOwnerPayload, body: '別所有者の架空日記' },
      {},
      secondOwner,
    );
    const secondEntry = (await secondEntryResponse.json()) as { id: string; body: string };
    expect(secondEntryResponse.status).toBe(201);
    expect(secondEntry.id).not.toBe(firstEntry.id);

    expect((await request(`/entries/${firstEntry.id}`, 'DELETE')).status).toBe(202);
    expect((await request('/entries', 'POST', firstOwnerPayload)).status).toBe(404);
    expect(
      (await request('/entries', 'POST', { ...firstOwnerPayload, body: '再利用を試す別内容' }))
        .status,
    ).toBe(404);
    expect(
      await (
        await request(
          '/entries',
          'POST',
          { ...firstOwnerPayload, body: '別所有者の架空日記' },
          {},
          secondOwner,
        )
      ).json(),
    ).toMatchObject({
      id: secondEntry.id,
      body: '別所有者の架空日記',
    });
  });
  it('isolates entry, generation and asset by mock session', async () => {
    const entry = await create();
    await request(
      `/entries/${entry.id}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: '' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    const detail = await (await request(`/entries/${entry.id}`)).json();
    const other = crypto.randomUUID();
    for (const path of [
      `/entries/${entry.id}`,
      `/generations/${detail.latestGeneration.id}`,
      `/assets/${detail.latestGeneration.comic.visual.assetId}/url`,
    ]) {
      expect((await request(path, 'GET', undefined, {}, other)).status).toBe(404);
    }
  });
  it('deduplicates parallel creation and generation and consumes one mock quota', async () => {
    const body = {
      createRequestId: crypto.randomUUID(),
      diaryDate: jstToday(),
      body: '普通の一日。',
      consentVersion: 'v1',
    };
    const created = await Promise.all(
      Array.from({ length: 3 }, () => request('/entries', 'POST', body).then((r) => r.json())),
    );
    expect(new Set(created.map((x) => x.id)).size).toBe(1);
    const id = created[0].id;
    const key = crypto.randomUUID();
    const generated = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(
          `/entries/${id}/generations`,
          'POST',
          { expectedRevision: 1, captchaToken: '' },
          { 'Idempotency-Key': key },
        ).then((r) => r.json()),
      ),
    );
    expect(new Set(generated.map((x) => x.generationId)).size).toBe(1);
    expect((await (await request('/me/quota')).json()).remainingToday).toBe(1);
    const replayedGeneration = await request(
      `/entries/${id}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: '' },
      { 'Idempotency-Key': key },
    );
    expect(replayedGeneration.status).toBe(202);
    expect(await replayedGeneration.json()).toMatchObject({
      generationId: generated[0].generationId,
    });
    const secondSameRevision = await request(
      `/entries/${id}/generations`,
      'POST',
      { expectedRevision: 1, captchaToken: '' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(secondSameRevision.status).toBe(409);
    expect((await secondSameRevision.json()).error).toMatchObject({
      code: 'REVISION_ALREADY_GENERATED',
      message: 'この改訂版の漫画はすでに保存されています。最新の状態を読み込んでください。',
    });
    const revised = await request(`/entries/${id}`, 'PATCH', {
      expectedRevision: 1,
      diaryDate: jstToday(),
      body: '改訂後の日記',
    });
    expect((await revised.json()).revision).toBe(2);
    const secondGeneration = await request(
      `/entries/${id}/generations`,
      'POST',
      { expectedRevision: 2, captchaToken: '' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(secondGeneration.status).toBe(202);
    const revisedAgain = await request(`/entries/${id}`, 'PATCH', {
      expectedRevision: 2,
      diaryDate: jstToday(),
      body: '再改訂後の日記',
    });
    expect((await revisedAgain.json()).revision).toBe(3);
    const limited = await request(
      `/entries/${id}/generations`,
      'POST',
      { expectedRevision: 3, captchaToken: '' },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatchObject({
      code: 'USER_LIMIT_REACHED',
      message: '本日の生成上限に達しました。',
      retryable: false,
    });
    expect(
      (
        await request(
          `/entries/${id}/generations`,
          'POST',
          { expectedRevision: 2, captchaToken: '' },
          { 'Idempotency-Key': key },
        )
      ).status,
    ).toBe(409);
  });
  it('checks revisions and rejects privilege fields, oversized bodies and foreign origins', async () => {
    const entry = await create();
    expect(
      (
        await request(`/entries/${entry.id}`, 'PATCH', {
          expectedRevision: 2,
          diaryDate: jstToday(),
          body: '改訂',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request('/entries', 'POST', {
          createRequestId: crypto.randomUUID(),
          diaryDate: jstToday(),
          body: 'test',
          consentVersion: 'v1',
          ownerId: 'evil',
        })
      ).status,
    ).toBe(400);
    expect((await request('/entries', 'POST', { body: 'x'.repeat(17000) })).status).toBe(413);
    expect(
      (await request('/entries', 'GET', undefined, { Origin: 'https://example.com' })).status,
    ).toBe(401);
  });
  it('does not cache JSON errors or turn missing API routes into HTML', async () => {
    const response = await request('/missing');
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const denied = await app.request('http://localhost/api/v1/entries', {}, mockEnvironment);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('Cache-Control')).toBe('no-store');
  });
  it('keeps production samples public but refuses individual data APIs', async () => {
    const env = {
      ...mockEnvironment,
      APP_ENV: 'production' as const,
      DATA_MODE: 'sample' as const,
    };
    const production = createApp();
    expect((await production.request('https://app.example/api/v1/config', {}, env)).status).toBe(
      200,
    );
    expect((await production.request('https://app.example/api/v1/entries', {}, env)).status).toBe(
      503,
    );
    expect(
      (await production.request('https://app.example/api/v1/health', {}, mockEnvironment)).status,
    ).toBe(503);
  });
});
describe('environment modes', () => {
  it('accepts only the documented combinations and refuses mock auth outside local development', () => {
    expect(resolveMode(mockEnvironment, true)).toBe('local-mock');
    expect(() => resolveMode(mockEnvironment, false)).toThrow();
    expect(() => resolveMode({ ...mockEnvironment, APP_ENV: 'production' }, true)).toThrow();
    expect(() => resolveMode({ ...mockEnvironment, GENERATION_ENABLED: 'true' }, true)).toThrow();
    expect(() => resolveMode({ ...mockEnvironment, GENERATION_ENABLED: '1' }, true)).toThrow();
    expect(resolveMode({ APP_ENV: 'staging', DATA_MODE: 'live', AI_MODE: 'mock' }, false)).toBe(
      'local-connected',
    );
    expect(
      resolveMode(
        { APP_ENV: 'production', DATA_MODE: 'live', AI_MODE: 'live', GENERATION_ENABLED: 'false' },
        false,
      ),
    ).toBe('live-demo');
  });
});
it('distinguishes draft limits from daily generation limits', async () => {
  for (let i = 0; i < 20; i++) await create();
  const response = await request('/entries', 'POST', {
    createRequestId: crypto.randomUUID(),
    diaryDate: jstToday(),
    body: '上限確認の架空日記',
    consentVersion: 'v1',
  });
  expect(response.status).toBe(429);
  expect((await response.json()).error.code).toBe('DRAFT_LIMIT_REACHED');
  expect((await (await request('/me/quota')).json()).remainingToday).toBe(2);
});

it('serves all generation states and exposes only successful owned assets', async () => {
  const repository = createMockRepository();
  app = createApp({ localDevelopment: true, repository });
  const entry = await create();
  const id = crypto.randomUUID();
  const fixtures = generationFixtures(entry.id, id);
  repository.entries.get(entry.id)!.entry.latestGenerationId = id;
  for (const generation of Object.values(fixtures)) {
    repository.generations.set(id, { owner, key: crypto.randomUUID(), generation });
    expect(await (await request(`/generations/${id}`)).json()).toEqual(generation);
    const detail = await (await request(`/entries/${entry.id}`)).json();
    expect(detail.latestGeneration.status).toBe(generation.status);
    if (generation.status !== 'succeeded') {
      const asset = fixtures.succeeded.comic.visual;
      if (asset.kind === 'page')
        expect((await request(`/assets/${asset.assetId}/url`)).status).toBe(404);
    }
  }
  repository.generations.set(id, {
    owner,
    key: crypto.randomUUID(),
    generation: { ...fixtures.succeeded, comic: panelsComic },
  });
  if (panelsComic.visual.kind !== 'panels') throw new Error('panels fixture required');
  for (const assetId of panelsComic.visual.assetIds) {
    expect((await request(`/assets/${assetId}/url`)).status).toBe(200);
    expect(
      (await request(`/assets/${assetId}/url`, 'GET', undefined, {}, crypto.randomUUID())).status,
    ).toBe(404);
  }
});

it('keeps a prior mock success visible after the latest job fails', async () => {
  const repository = createMockRepository();
  app = createApp({ localDevelopment: true, repository });
  const entry = await create();
  const successfulId = crypto.randomUUID();
  const failedId = crypto.randomUUID();
  const fixtures = generationFixtures(entry.id, successfulId, 1);
  const failed = generationFixtures(entry.id, failedId, 2).failed;
  repository.generations.set(successfulId, {
    owner,
    key: crypto.randomUUID(),
    generation: fixtures.succeeded,
  });
  repository.generations.set(failedId, {
    owner,
    key: crypto.randomUUID(),
    generation: failed,
  });
  const foreignSuccess = generationFixtures(entry.id, crypto.randomUUID(), 2).succeeded;
  repository.generations.set(foreignSuccess.id, {
    owner: crypto.randomUUID(),
    key: crypto.randomUUID(),
    generation: foreignSuccess,
  });
  const futureSuccess = generationFixtures(entry.id, crypto.randomUUID(), 3).succeeded;
  repository.generations.set(futureSuccess.id, {
    owner,
    key: crypto.randomUUID(),
    generation: futureSuccess,
  });
  const storedEntry = repository.entries.get(entry.id)!.entry;
  storedEntry.revision = 2;
  storedEntry.latestGenerationId = failedId;

  const detailAfterFailure = await (await request(`/entries/${entry.id}`)).json();
  expect(detailAfterFailure.latestGeneration.id).toBe(failedId);
  expect(detailAfterFailure.latestGeneration.status).toBe('failed');
  expect(detailAfterFailure.latestGenerationId).toBe(failedId);
  expect(detailAfterFailure.lastSuccessfulGeneration.id).toBe(successfulId);

  const newestSuccessId = crypto.randomUUID();
  const newestSuccess = generationFixtures(entry.id, newestSuccessId, 2).succeeded;
  repository.generations.set(newestSuccessId, {
    owner,
    key: crypto.randomUUID(),
    generation: newestSuccess,
  });
  storedEntry.latestGenerationId = newestSuccessId;
  const detailAfterSuccess = await (await request(`/entries/${entry.id}`)).json();
  expect(detailAfterSuccess.latestGenerationId).toBe(newestSuccessId);
  expect(detailAfterSuccess.lastSuccessfulGeneration.id).toBe(newestSuccessId);
});
