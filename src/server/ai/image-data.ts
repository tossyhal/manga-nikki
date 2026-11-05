import type { RenderedPanel } from './image-provider';

export class ImageGenerationError extends Error {
  constructor(
    public readonly code: string,
    public readonly failedPanel: number,
    public readonly completedPanels: RenderedPanel[],
    public readonly providerStatus?: number,
  ) {
    super(code);
    this.name = 'ImageGenerationError';
  }
}

// MIME宣言と画像の先頭バイトの両方を検証する。
export function decodeImage(data: string, mime: string | undefined): RenderedPanel['data'] {
  if (data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4) throw new Error('IMAGE_TOO_LARGE');
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  const prefix = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const png =
    mime === 'image/png' && bytes.length >= 24 && prefix([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = mime === 'image/jpeg' && bytes.length >= 4 && prefix([255, 216, 255]);
  const webp =
    mime === 'image/webp' &&
    bytes.length >= 12 &&
    prefix([82, 73, 70, 70]) &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80;
  if ((!png && !jpeg && !webp) || bytes.length > 8 * 1024 * 1024) throw new Error('INVALID_IMAGE');
  return bytes;
}
