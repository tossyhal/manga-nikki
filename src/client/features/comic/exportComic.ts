import type { ComicDocument } from '../../../shared/schemas';

function lines(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (line && context.measureText(line + character).width > width) {
        result.push(line);
        line = '';
      }
      line += character;
    }
    result.push(line);
  }
  return result;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error('IMAGE_DOWNLOAD_FAILED');
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function exportComic(
  comic: ComicDocument,
  urls: Record<string, string>,
): Promise<Blob> {
  const ids = comic.visual.kind === 'page' ? [comic.visual.assetId] : comic.visual.assetIds;
  const images = await Promise.all(
    ids.map((id) => {
      if (!urls[id]) throw new Error('IMAGE_NOT_READY');
      return loadImage(urls[id]);
    }),
  );
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('CANVAS_UNAVAILABLE');
  canvas.width = 848;
  context.font = '24px sans-serif';
  const captions = comic.panels.map((panel) =>
    lines(
      context,
      `${panel.index}. ${panel.caption || panel.scene}${panel.dialogue ? `\n「${panel.dialogue}」` : ''}`,
      776,
    ),
  );
  const titleLines = lines(context, comic.title, 776);
  const imageHeights = images.map((image) =>
    Math.round((800 * image.naturalHeight) / image.naturalWidth),
  );
  const showCaptions = comic.visual.textMode === 'external';
  canvas.height =
    48 +
    titleLines.length * 34 +
    imageHeights.reduce(
      (sum, height, i) =>
        sum +
        height +
        24 +
        (showCaptions
          ? (comic.visual.kind === 'page' ? captions.flat().length : (captions[i]?.length ?? 0)) *
              34 +
            24
          : 0),
      0,
    );
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#333';
  context.font = '24px sans-serif';
  let y = 32;
  for (const line of titleLines) {
    context.fillText(line, 24, y);
    y += 34;
  }
  y += 16;
  images.forEach((image, index) => {
    context.drawImage(image, 24, y, 800, imageHeights[index]!);
    y += imageHeights[index]! + 24;
    if (showCaptions) {
      const text = comic.visual.kind === 'page' ? captions.flat() : (captions[index] ?? []);
      for (const line of text) {
        context.fillText(line, 36, y + 22);
        y += 34;
      }
      y += 24;
    }
  });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('IMAGE_EXPORT_FAILED'))),
      'image/png',
    ),
  );
}
