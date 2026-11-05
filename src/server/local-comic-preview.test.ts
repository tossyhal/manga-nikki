import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sample from '../../docs/contracts/script.example.json';
import { scriptSchema } from './ai/script-schema';
import { renderComicPreview } from './comic-preview';
import { startComicPreview } from './local-comic-preview';

let directory: string;
let preview: Awaited<ReturnType<typeof startComicPreview>>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'comic-preview-test-'));
  await writeFile(
    join(directory, 'index.html'),
    renderComicPreview({
      script: scriptSchema.parse(sample),
      images: [1, 2, 3, 4].map((index) => ({ index, url: `panel-${index}.png` })),
      notice: 'ローカル実生成プレビュー。',
    }),
  );
  await writeFile(join(directory, 'panel-1.png'), new Uint8Array([137, 80, 78, 71]));
  await writeFile(join(directory, 'result.json'), '{"private":true}');
  preview = await startComicPreview(directory);
});
afterEach(async () => {
  if (preview) {
    preview.server.closeAllConnections();
    await new Promise<void>((resolve) => preview.server.close(() => resolve()));
  }
  await rm(directory, { recursive: true, force: true });
});

describe('保存済み漫画のローカルWebプレビュー', () => {
  it('ルートページに漫画全体とキャプションを表示し、コマ画像を取得できる', async () => {
    const page = await fetch(preview.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toContain('text/html');
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    const html = await page.text();
    expect(html.match(/<img\s/g)).toHaveLength(4);
    expect(html).toContain(sample.panels[3]!.caption);
    const image = await fetch(new URL('panel-1.png', preview.url));
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });
  it('脚本・実行記録・任意パスを配信せず、別Originや書き込みを拒否する', async () => {
    for (const path of [
      'result.json',
      'script.json',
      '.dev.vars',
      '%2e%2e%2f.dev.vars',
      'panel-5.png',
      'index.html?secret=1',
    ]) {
      expect((await fetch(new URL(path, preview.url))).status).toBe(404);
    }
    expect((await fetch(preview.url, { headers: { Origin: 'https://example.com' } })).status).toBe(
      403,
    );
    expect((await fetch(preview.url, { method: 'POST' })).status).toBe(405);
    const head = await fetch(preview.url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
