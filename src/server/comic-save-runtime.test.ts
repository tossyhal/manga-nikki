import { beforeEach, describe, expect, it, vi } from 'vitest';
import scriptSample from '../../docs/contracts/script.example.json';
import { openaiGenerationProfile } from './ai/openai-generation-profile';
import { openaiImageModelProfile } from './ai/openai-image-provider';
import { openaiScriptModelProfile } from './ai/openai-script-provider';
import { scriptSchema } from './ai/script-schema';
import {
  GenerationSaveDependencyError,
  createGenerationSaveRuntime,
  createSupabaseGenerationSaveBackend,
} from './comic-save-runtime';
import type { GenerationSaveBackend } from './comic-save-runtime';
import type { SaveGeneratedComicInput } from './generation-save-handler';
import { mockEnvironment, type Environment } from './mode';

const generationId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const claimToken = '44444444-4444-4444-8444-444444444444';
const firstSaveToken = '55555555-5555-4555-8555-555555555555';
const recoverySaveToken = '66666666-6666-4666-8666-666666666666';
const assetIds = [
  'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaa0001',
  'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaa0002',
  'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaa0003',
  'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaa0004',
];
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12P4DwQACfsD/WMmxY8AAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
);
const script = scriptSchema.parse(structuredClone(scriptSample));
const deadlineAt = new Date(Date.now() + 15 * 60_000).toISOString();

function saveInput(): SaveGeneratedComicInput {
  return {
    generation: {
      generationId,
      entryId,
      ownerId,
      entryRevision: 1,
      diaryDate: '2026-11-05',
      claimToken,
      deadlineAt,
    },
    profileId: openaiGenerationProfile.profileId,
    script,
    rendered: {
      kind: 'panels',
      textMode: 'external',
      modelId: openaiImageModelProfile.modelId,
      panels: [1, 2, 3, 4].map((index) => ({
        index: index as 1 | 2 | 3 | 4,
        mediaType: 'image/png' as const,
        data: png,
      })) as SaveGeneratedComicInput['rendered']['panels'],
    },
    providerCalls: {
      script: {
        stage: 'script',
        callIndex: 1,
        modelId: openaiScriptModelProfile.modelId,
        requestId: 'script-request',
      },
      images: [1, 2, 3, 4].map((callIndex) => ({
        stage: 'images' as const,
        callIndex,
        modelId: openaiImageModelProfile.modelId,
        requestId: `image-${callIndex}-request`,
      })),
    },
  };
}

function taskFromBegin(args: Record<string, unknown>) {
  const manifest = args.p_asset_metadata as {
    index: number;
    media_type: string;
    byte_size: number;
    width: number;
    height: number;
    sha256: string;
  }[];
  const metadata = manifest.map((asset, index) => ({
    ...asset,
    asset_id: assetIds[index]!,
    object_path: `${ownerId}/${generationId}/${assetIds[index]}.png`,
  }));
  const draft = {
    schemaVersion: 1,
    title: script.title,
    panels: script.panels,
    visual: {
      kind: 'panels',
      assetIds,
      textMode: 'external',
    },
  };
  return {
    owner_id: ownerId,
    entry_id: entryId,
    entry_revision: 1,
    diary_date: '2026-11-05',
    claim_token: claimToken,
    deadline_at: deadlineAt,
    profile_id: openaiGenerationProfile.profileId,
    script,
    comic_draft: draft,
    asset_metadata: metadata,
  };
}

class FakeSaveBackend implements GenerationSaveBackend {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly objects = new Map<string, Uint8Array>();
  readonly uploadPaths: string[] = [];
  failCompleteCount = 0;
  failUploadCount = 0;
  uploadFailure: GenerationSaveDependencyError | undefined;
  recoveryStatus: 'claimed' | 'pending' | 'failed' | 'cancelled' = 'claimed';
  recoveryTask: unknown;
  saveTask: ReturnType<typeof taskFromBegin> | undefined;

  async callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'begin_comic_save_task') {
      this.saveTask ??= taskFromBegin(args);
      return {
        status: 'claimed',
        generation_id: generationId,
        save_claim_token: firstSaveToken,
        lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        task: this.saveTask,
      };
    }
    if (name === 'claim_comic_save_recovery') {
      if (this.recoveryStatus !== 'claimed')
        return {
          status: this.recoveryStatus,
          generation_id: generationId,
          ...(this.recoveryStatus === 'failed' || this.recoveryStatus === 'cancelled'
            ? { reservation_state: 'consumed', released: false }
            : {}),
        };
      return {
        status: 'claimed',
        generation_id: generationId,
        save_claim_token: recoverySaveToken,
        lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        task: this.recoveryTask ?? this.saveTask,
      };
    }
    if (name === 'complete_comic_save') {
      if (this.failCompleteCount > 0) {
        this.failCompleteCount -= 1;
        throw new GenerationSaveDependencyError('rpc', 503);
      }
      expect(this.objects.size).toBe(4);
      const manifest = args.p_asset_metadata as Record<string, unknown>[];
      expect(manifest).toHaveLength(4);
      expect(manifest.every((asset) => !('asset_id' in asset) && !('object_path' in asset))).toBe(
        true,
      );
      return {
        status: 'succeeded',
        generation_id: generationId,
        comic_json: args.p_comic_json,
        asset_ids: assetIds,
      };
    }
    if (name === 'fail_comic_save')
      return {
        status: 'failed',
        generation_id: generationId,
        reservation_state: 'consumed',
        released: false,
      };
    throw new Error('UNEXPECTED_RPC');
  }

  async upload(path: string, bytes: Uint8Array): Promise<void> {
    this.uploadPaths.push(path);
    if (this.uploadFailure) throw this.uploadFailure;
    if (this.failUploadCount > 0) {
      this.failUploadCount -= 1;
      throw new GenerationSaveDependencyError('storage', 503);
    }
    this.objects.set(path, bytes.slice());
  }

  async download(path: string): Promise<Uint8Array> {
    const bytes = this.objects.get(path);
    if (!bytes) throw new GenerationSaveDependencyError('storage', 400, 'NoSuchKey');
    return bytes.slice();
  }
}

function runtimeFor(backend: FakeSaveBackend) {
  return createGenerationSaveRuntime(() => backend);
}

function context(signal = new AbortController().signal) {
  return { environment: mockEnvironment as Environment, signal };
}

describe('private comic save runtime', () => {
  let backend: FakeSaveBackend;

  beforeEach(() => {
    backend = new FakeSaveBackend();
  });

  it('registers metadata before upserting four private objects and only then completes the DB job', async () => {
    const result = await runtimeFor(backend).saveGeneratedComic(saveInput(), context());
    expect(result).toEqual({ generationId, status: 'succeeded' });
    expect(backend.calls.map((call) => call.name)).toEqual([
      'begin_comic_save_task',
      'complete_comic_save',
    ]);
    expect(backend.uploadPaths).toEqual(
      assetIds.map((id) => `${ownerId}/${generationId}/${id}.png`),
    );
    expect(backend.calls[0]!.args.p_asset_metadata).toHaveLength(4);
    expect(backend.calls[0]!.args.p_asset_metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      ]),
    );
  });

  it('keeps a task pending after a DB completion outage and recovers by downloading verified bytes without AI calls', async () => {
    backend.failCompleteCount = 1;
    const aiCalls = vi.fn();
    await expect(runtimeFor(backend).saveGeneratedComic(saveInput(), context())).rejects.toThrow(
      'GENERATION_SAVE_PENDING',
    );

    const result = await runtimeFor(backend).recoverGeneratedComic(generationId, context());
    expect(result).toEqual({ generationId, status: 'succeeded' });
    expect(backend.calls.map((call) => call.name)).toEqual([
      'begin_comic_save_task',
      'complete_comic_save',
      'claim_comic_save_recovery',
      'complete_comic_save',
    ]);
    expect(aiCalls).not.toHaveBeenCalled();
  });

  it('finalizes a recovery with missing stored bytes as failed and consumed', async () => {
    backend.recoveryTask = taskFromBegin({
      p_asset_metadata: [1, 2, 3, 4].map((index) => ({
        index,
        media_type: 'image/png',
        byte_size: png.byteLength,
        width: 1,
        height: 1,
        sha256: 'a'.repeat(64),
      })),
    });
    const result = await runtimeFor(backend).recoverGeneratedComic(generationId, context());
    expect(result).toEqual({ generationId, status: 'failed' });
    expect(backend.calls.map((call) => call.name)).toEqual([
      'claim_comic_save_recovery',
      'fail_comic_save',
    ]);
    expect(backend.calls[1]!.args).toEqual({
      p_generation_id: generationId,
      p_claim_token: claimToken,
      p_save_claim_token: recoverySaveToken,
    });
  });

  it('keeps recovery pending for temporary Storage errors', async () => {
    const task = taskFromBegin({
      p_asset_metadata: [1, 2, 3, 4].map((index) => ({
        index,
        media_type: 'image/png',
        byte_size: png.byteLength,
        width: 1,
        height: 1,
        sha256: 'a'.repeat(64),
      })),
    });
    backend.recoveryTask = task;
    backend.objects.set(task.asset_metadata[0]!.object_path, png);
    backend.download = async () => {
      throw new GenerationSaveDependencyError('storage', 503);
    };
    const result = await runtimeFor(backend).recoverGeneratedComic(generationId, context());
    expect(result).toEqual({ generationId, status: 'pending' });
    expect(backend.calls.some((call) => call.name === 'fail_comic_save')).toBe(false);
  });

  it.each(['429', '503'])(
    'keeps an HTTP 400 upload pending when Storage statusCode is %s',
    async (innerStatus) => {
      backend.uploadFailure = new GenerationSaveDependencyError('storage', 400, innerStatus);
      await expect(runtimeFor(backend).saveGeneratedComic(saveInput(), context())).rejects.toThrow(
        'GENERATION_SAVE_PENDING',
      );
      expect(backend.uploadPaths).toHaveLength(2);
      expect(backend.calls.map((call) => call.name)).toEqual(['begin_comic_save_task']);
    },
  );

  it.each([
    ['missing bucket', new GenerationSaveDependencyError('storage', 404, 'NoSuchBucket')],
    ['gateway 404', new GenerationSaveDependencyError('storage', 404, 'GatewayNotFound')],
    ['numeric 404 without object code', new GenerationSaveDependencyError('storage', 400, '404')],
  ])('keeps %s during recovery pending instead of consuming the job', async (_label, error) => {
    backend.recoveryTask = taskFromBegin({
      p_asset_metadata: [1, 2, 3, 4].map((index) => ({
        index,
        media_type: 'image/png',
        byte_size: png.byteLength,
        width: 1,
        height: 1,
        sha256: 'a'.repeat(64),
      })),
    });
    backend.download = async () => {
      throw error;
    };

    const result = await runtimeFor(backend).recoverGeneratedComic(generationId, context());
    expect(result).toEqual({ generationId, status: 'pending' });
    expect(backend.calls.some((call) => call.name === 'fail_comic_save')).toBe(false);
  });

  it('recognizes Supabase Storage NoSuchKey when HTTP status is 400', async () => {
    const environment: Environment = {
      ...mockEnvironment,
      APP_ENV: 'staging',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      SUPABASE_URL: 'https://save-runtime-test.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    const fetcher: typeof fetch = async () =>
      Response.json(
        { statusCode: '404', message: 'Object not found', error: 'Not Found', code: 'NoSuchKey' },
        { status: 400 },
      );
    const service = createSupabaseGenerationSaveBackend(
      environment,
      new AbortController().signal,
      fetcher,
    );
    await expect(
      service.download(`${ownerId}/${generationId}/${assetIds[0]}.png`),
    ).rejects.toMatchObject({
      kind: 'storage',
      status: 404,
      serviceCode: 'NoSuchKey',
    });
  });

  it('prioritizes numeric Storage statusCode from an HTTP 400 response', async () => {
    const environment: Environment = {
      ...mockEnvironment,
      APP_ENV: 'staging',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      SUPABASE_URL: 'https://save-runtime-test.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    const fetcher: typeof fetch = async () =>
      Response.json(
        { statusCode: '503', message: 'Storage unavailable', code: 'SlowDown' },
        { status: 400 },
      );
    const service = createSupabaseGenerationSaveBackend(
      environment,
      new AbortController().signal,
      fetcher,
    );
    await expect(
      service.upload(`${ownerId}/${generationId}/${assetIds[0]}.png`, png, 'image/png'),
    ).rejects.toMatchObject({ kind: 'storage', status: 503, serviceCode: 'SlowDown' });
  });

  it('uses a service-only client and upserts the same object path with the original content', async () => {
    const environment: Environment = {
      ...mockEnvironment,
      APP_ENV: 'staging',
      DATA_MODE: 'live',
      AI_MODE: 'live',
      SUPABASE_URL: 'https://save-runtime-test.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    };
    const controller = new AbortController();
    const signal = controller.signal;
    let request: Request | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ Id: assetIds[0], Key: `comics/${ownerId}/${assetIds[0]}.png` });
    };
    const service = createSupabaseGenerationSaveBackend(environment, signal, fetcher);
    const objectPath = `${ownerId}/${generationId}/${assetIds[0]}.png`;
    await service.upload(objectPath, png, 'image/png');

    expect(request?.url).toBe(
      `https://save-runtime-test.supabase.co/storage/v1/object/comics/${objectPath}`,
    );
    expect(request?.headers.get('apikey')).toBe('sb_secret_test');
    expect(request?.headers.get('authorization')).toBe('Bearer sb_secret_test');
    expect(request?.headers.get('x-upsert')).toBe('true');
    expect(request?.headers.get('content-type')).toBe('image/png');
    expect(request?.headers.get('cache-control')).toBe('max-age=0');
    expect(request?.signal.aborted).toBe(false);
    controller.abort();
    expect(request?.signal.aborted).toBe(true);
  });

  it.each([
    ['DB terminal failure', 'failed'],
    ['DB cancellation', 'cancelled'],
    ['already terminal unknown job', 'unknown'],
  ])('%s does not start AI or Storage work', async (_label, status) => {
    backend.recoveryStatus = status as 'failed' | 'cancelled';
    const result = await runtimeFor(backend).recoverGeneratedComic(generationId, context());
    expect(result).toEqual({
      generationId,
      status: status === 'unknown' ? 'pending' : status,
    });
    expect(backend.uploadPaths).toHaveLength(0);
    expect(backend.objects.size).toBe(0);
  });

  it('retries a transient upload once with the same content and deterministic path', async () => {
    backend.failUploadCount = 1;
    const result = await runtimeFor(backend).saveGeneratedComic(saveInput(), context());
    expect(result.status).toBe('succeeded');
    expect(backend.uploadPaths).toHaveLength(5);
    expect(backend.uploadPaths[0]).toBe(backend.uploadPaths[1]);
    expect(backend.objects.size).toBe(4);
  });

  it('does not write when the original claim deadline has expired', async () => {
    const validInput = saveInput();
    const expiredInput: SaveGeneratedComicInput = {
      ...validInput,
      generation: { ...validInput.generation, deadlineAt: new Date(Date.now() - 1).toISOString() },
    };
    await expect(runtimeFor(backend).saveGeneratedComic(expiredInput, context())).rejects.toThrow(
      'GENERATION_SAVE_PENDING',
    );
    expect(backend.calls).toHaveLength(0);
    expect(backend.uploadPaths).toHaveLength(0);
  });
});
