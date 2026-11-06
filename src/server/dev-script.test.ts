import { describe, expect, it, vi } from 'vitest';
import sampleScript from '../../docs/contracts/script.example.json';
import { createApp } from './app';
import { mockEnvironment, type Environment } from './mode';
import { scriptSchema } from './ai/script-schema';

const path = '/api/v1/dev/script';

describe('ローカル開発用の脚本API', () => {
  it('認証不要で検証済み固定脚本を返し、キャッシュしない', async () => {
    const app = createApp({ localDevelopment: true });
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const response = await app.request(`http://${host}${path}`, {}, mockEnvironment);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({ mock: true, script: sampleScript });
    }
  });

  it('開発ビルド以外ではlocalhostでも公開しない', async () => {
    const app = createApp();
    const response = await app.request(`http://localhost${path}`, {}, mockEnvironment);
    expect(response.status).toBe(404);
  });

  it('外部ホストと別Originを拒否する', async () => {
    const app = createApp({ localDevelopment: true });
    expect((await app.request(`https://example.com${path}`, {}, mockEnvironment)).status).toBe(404);
    const response = await app.request(
      `http://localhost${path}`,
      { headers: { Origin: 'https://example.com' } },
      mockEnvironment,
    );
    expect(response.status).toBe(404);
  });

  it('local-mock以外の全モードで脚本を返さない', async () => {
    const app = createApp({ localDevelopment: true });
    const environments: Environment[] = [
      { ...mockEnvironment, DATA_MODE: 'live' },
      { ...mockEnvironment, APP_ENV: 'production', DATA_MODE: 'sample' },
      { ...mockEnvironment, APP_ENV: 'production', DATA_MODE: 'live', AI_MODE: 'live' },
    ];
    for (const env of environments) {
      const response = await app.request(`http://localhost${path}`, {}, env);
      expect(response.status).toBe(404);
      expect(await response.json()).not.toHaveProperty('script');
    }
  });

  it('不正な環境設定では停止する', async () => {
    const app = createApp({ localDevelopment: true });
    const response = await app.request(`http://localhost${path}`, {}, {});
    expect(response.status).toBe(503);
  });

  it('サンプルが検証に失敗したら詳細を漏らさず503を返す', async () => {
    const spy = vi.spyOn(scriptSchema, 'safeParse').mockReturnValueOnce(scriptSchema.safeParse({}));
    try {
      const response = await createApp({ localDevelopment: true }).request(
        `http://localhost${path}`,
        {},
        mockEnvironment,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty('script');
    } finally {
      spy.mockRestore();
    }
  });
});
