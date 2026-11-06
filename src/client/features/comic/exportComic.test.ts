import { afterEach, describe, expect, test, vi } from 'vitest';
import { pageComic, panelsComic } from '../../../shared/fixtures';
import { exportComic } from './exportComic';

function mockCanvas() {
  const fillText = vi.fn();
  const context = {
    font: '',
    fillStyle: '',
    measureText: (text: string) => ({ width: text.length }),
    fillRect: vi.fn(),
    fillText,
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    getContext: vi.fn(() => context),
    toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
  } as unknown as HTMLCanvasElement;

  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) }),
  );
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 800;
      naturalHeight = 1000;
      src = '';
      decode() {
        return Promise.resolve();
      }
    },
  );
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:comic-image'),
    revokeObjectURL: vi.fn(),
  });

  return fillText;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([
  ['page', pageComic],
  ['panels', panelsComic],
] as const)('%s漫画のPNG出力', (_kind, template) => {
  test('空captionではsceneを出さず、dialogueだけと通常captionを描画する', async () => {
    const comic = structuredClone(template);
    comic.panels[0].caption = '';
    comic.panels[0].dialogue = 'セリフだけを表示';
    comic.panels[1].caption = '';
    comic.panels[1].dialogue = '';
    comic.panels[2].dialogue = '通常captionとセリフ';
    const fillText = mockCanvas();
    const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
    const urls = Object.fromEntries(ids.map((id) => [id, 'https://example.test/comic.png']));

    await exportComic(comic, urls);

    const renderedText = fillText.mock.calls.map(([text]) => text);
    expect(renderedText).toContain('「セリフだけを表示」');
    expect(renderedText).not.toContain(comic.panels[0].scene);
    expect(renderedText).not.toContain(comic.panels[1].scene);
    expect(renderedText).not.toContain(`${comic.panels[1].index}. `);
    expect(renderedText).toContain(`${comic.panels[2].index}. ${comic.panels[2].caption}`);
    expect(renderedText).toContain(`「${comic.panels[2].dialogue}」`);
  });
});

test('embeddedのpage漫画では文章をPNGへ重ね描きしない', async () => {
  const comic = structuredClone(pageComic);
  if (comic.visual.kind !== 'page') throw new Error('page comic fixture is required');
  comic.visual.textMode = 'embedded';
  const fillText = mockCanvas();
  const urls = { [comic.visual.assetId]: 'https://example.test/comic.png' };

  await exportComic(comic, urls);

  expect(fillText.mock.calls.map(([text]) => text)).toEqual([comic.title]);
});
