import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { mockEnvironment } from './mode';
import { jstToday } from '../shared/schemas';
import { pageComic } from '../shared/fixtures';
import { newShareToken, readComicShare, toSharedComic } from './comic-shares';

describe('漫画の共有', () => {
  it('公開用の漫画には内部の描画指示を含めず、見える文章だけを残す', () => {
    const original = structuredClone(pageComic);
    original.panels[0].scene = '絵の描画指示にだけ含まれる詳しい個人情報';
    original.panels[0].caption = '共有する文章';
    original.panels[1].scene = '空のcaptionからも描画指示を公開しない';
    original.panels[1].caption = '';
    const result = toSharedComic(original);
    expect(result.panels[0].scene).toBe('共有する文章');
    expect(result.panels[1].scene).toBe('2コマ目');
    expect(JSON.stringify(result)).not.toContain('描画指示');
    expect(original.panels[0].scene).toContain('個人情報');
  });
  it('選んだ漫画だけを匿名で読め、本文を返さず、削除後は共有を止める', async () => {
    const app = createApp({ localDevelopment: true });
    const owner = crypto.randomUUID();
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      actor: string | null = owner,
      headers = {},
    ) =>
      app.request(
        `http://localhost/api/v1${path}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(actor ? { Authorization: `Bearer mock:${actor}` } : {}),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        mockEnvironment,
      );
    const entry = await (
      await request('/entries', 'POST', {
        createRequestId: crypto.randomUUID(),
        diaryDate: jstToday(),
        body: '共有しない秘密の日記',
        consentVersion: 'v1',
      })
    ).json();
    const receipt = await (
      await request(
        `/entries/${entry.id}/generations`,
        'POST',
        { expectedRevision: 1, captchaToken: '' },
        owner,
        { 'Idempotency-Key': crypto.randomUUID() },
      )
    ).json();
    const path = `/generations/${receipt.generationId}/share`;
    expect((await request(path, 'POST', undefined, null)).status).toBe(401);
    expect((await request(path, 'POST', undefined, crypto.randomUUID())).status).toBe(404);
    const share = await request(path, 'POST');
    expect(share.status).toBe(201);
    const { path: sharePath } = await share.json();
    expect(sharePath).toMatch(/^\/shared\/[a-f0-9]{64}$/);
    expect(await (await request(path, 'POST')).json()).toEqual({ path: sharePath });
    const response = await request(sharePath, 'GET', undefined, null);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const data = await response.json();
    expect(Object.keys(data).sort()).toEqual(['comic', 'images']);
    expect(JSON.stringify(data)).not.toContain('共有しない秘密の日記');
    expect((await request('/shared/' + newShareToken(), 'GET', undefined, null)).status).toBe(404);
    await request(`/entries/${entry.id}`, 'DELETE');
    expect((await request(sharePath, 'GET', undefined, null)).status).toBe(404);
  });

  it('公開sample環境や不正tokenでDBに接続しない', async () => {
    const supabaseFetch = vi.fn();
    const app = createApp({ supabaseFetch });
    const env = {
      APP_ENV: 'staging',
      DATA_MODE: 'sample',
      AI_MODE: 'mock',
      GENERATION_ENABLED: 'false',
    };
    for (const token of ['invalid', newShareToken()]) {
      expect(
        (await app.request(`https://example.com/api/v1/shared/${token}`, {}, env)).status,
      ).toBe(404);
    }
    expect(supabaseFetch).not.toHaveBeenCalled();
  });

  it('共有が失効していれば署名URLを作らない', async () => {
    const fetcher = vi.fn(async () => Response.json(null));
    await expect(
      readComicShare(
        {
          ...mockEnvironment,
          SUPABASE_URL: 'https://example.supabase.co',
          SUPABASE_SECRET_KEY: 'server-test-key',
        },
        newShareToken(),
        fetcher as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('非公開Storageから共有画像を取得する境界', () => {
  const environment = {
    ...mockEnvironment,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'server-test-key',
  };
  const owner = '11111111-1111-4111-8111-111111111111';
  const generationId = '22222222-2222-4222-8222-222222222222';
  const id = pageComic.visual.kind === 'page' ? pageComic.visual.assetId : '';
  const path = `${owner}/${generationId}/${id}.png`;
  const row = {
    comic: pageComic,
    is_mock: false,
    assets: [
      {
        id,
        generation_id: generationId,
        owner_id: owner,
        object_path: path,
        media_type: 'image/png',
      },
    ],
  };
  it('private画像だけを60秒で署名し、内部メタデータを公開しない', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, body: await request.json() });
      return Response.json(
        request.url.includes('/rpc/')
          ? row
          : { signedURL: `/object/sign/comics/${path}?token=test` },
      );
    };
    const result = await readComicShare(environment, newShareToken(), fetcher);
    expect(Object.keys(result).sort()).toEqual(['comic', 'images']);
    expect(result.images[id]).toBe(
      `https://example.supabase.co/storage/v1/object/sign/comics/${path}?token=test`,
    );
    expect(calls.filter((call) => !call.url.includes('/rpc/'))).toEqual([
      {
        url: `https://example.supabase.co/storage/v1/object/sign/comics/${path}`,
        body: { expiresIn: 60 },
      },
    ]);
    expect(calls.filter((call) => call.url.includes('/rpc/'))).toHaveLength(2);
  });
  it('署名中に削除されたら画像URLを返さない', async () => {
    let reads = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/rpc/')) return Response.json(++reads === 1 ? row : null);
      return Response.json({ signedURL: `/object/sign/comics/${path}?token=test` });
    };
    await expect(readComicShare(environment, newShareToken(), fetcher)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('期待したowner/generation/assetのpathと一致しなければ署名しない', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        ...row,
        assets: [{ ...row.assets[0], object_path: 'another-owner/private.png' }],
      }),
    );
    await expect(
      readComicShare(environment, newShareToken(), fetcher as typeof fetch),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
