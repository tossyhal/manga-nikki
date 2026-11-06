import { describe, expect, it } from 'vitest';
import { inspectImageBytes, validateImageBytes } from './image-data';

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
}

const png = decodeBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12P4DwQACfsD/WMmxY8AAAAASUVORK5CYII=',
);
const jpeg = decodeBase64(
  '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AZb//2Q==',
);
const webp = decodeBase64('UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAfQ//73v/+BiOh/AAA=');

function jpegWithDimensions(width: number, height: number): Uint8Array {
  const result = jpeg.slice();
  let frameOffset = -1;
  for (let offset = 0; offset + 1 < result.length; offset += 1) {
    if (result[offset] === 0xff && result[offset + 1] === 0xc0) {
      frameOffset = offset;
      break;
    }
  }
  if (frameOffset < 0) throw new Error('JPEG frame marker missing');
  result[frameOffset + 5] = (height >> 8) & 0xff;
  result[frameOffset + 6] = height & 0xff;
  result[frameOffset + 7] = (width >> 8) & 0xff;
  result[frameOffset + 8] = width & 0xff;
  return result;
}

function corruptPngChunkCrc(bytes: Uint8Array, targetType: string): Uint8Array {
  const result = bytes.slice();
  let offset = 8;
  while (offset + 12 <= result.byteLength) {
    const length =
      result[offset]! * 0x1000000 +
      (result[offset + 1]! << 16) +
      (result[offset + 2]! << 8) +
      result[offset + 3]!;
    const type = String.fromCharCode(...result.subarray(offset + 4, offset + 8));
    if (type === targetType) {
      const crcOffset = offset + 8 + length;
      result[crcOffset] = result[crcOffset]! ^ 0x01;
      return result;
    }
    offset += 12 + length;
  }
  throw new Error(`PNG chunk ${targetType} missing`);
}

describe('画像バイナリ検証', () => {
  it('正規のPNG・JPEG・WebP fixtureから寸法を読む', () => {
    expect(inspectImageBytes(png, 'image/png')).toEqual({ width: 1, height: 1 });
    expect(inspectImageBytes(jpeg, 'image/jpeg')).toEqual({ width: 2, height: 3 });
    expect(inspectImageBytes(webp, 'image/webp')).toEqual({ width: 2, height: 3 });
  });

  it('MIME・シグネチャ・寸法が一致しない画像を拒否する', () => {
    expect(() => inspectImageBytes(png, 'image/jpeg')).toThrow('INVALID_IMAGE');
    expect(() => inspectImageBytes(new Uint8Array([1, 2, 3]), 'image/png')).toThrow(
      'INVALID_IMAGE',
    );
    expect(() => inspectImageBytes(jpegWithDimensions(0, 10), 'image/jpeg')).toThrow(
      'INVALID_IMAGE',
    );
    expect(() => inspectImageBytes(jpegWithDimensions(2049, 1), 'image/jpeg')).toThrow(
      'INVALID_IMAGE',
    );
    expect(() => inspectImageBytes(webp.slice(0, 24), 'image/webp')).toThrow('INVALID_IMAGE');
    expect(() => validateImageBytes(png, 'image/png')).not.toThrow();
  });

  it('PNG各chunkのCRCと末尾構造、JPEGのSOS・EOIまでの構造を検査する', () => {
    expect(() => inspectImageBytes(corruptPngChunkCrc(png, 'IDAT'), 'image/png')).toThrow(
      'INVALID_IMAGE',
    );
    expect(() => inspectImageBytes(png.slice(0, -1), 'image/png')).toThrow('INVALID_IMAGE');

    let frameOffset = -1;
    for (let offset = 0; offset + 1 < jpeg.length; offset += 1) {
      if (jpeg[offset] === 0xff && jpeg[offset + 1] === 0xc0) {
        frameOffset = offset;
        break;
      }
    }
    if (frameOffset < 0) throw new Error('JPEG frame marker missing');
    const frameLength = (jpeg[frameOffset + 2]! << 8) | jpeg[frameOffset + 3]!;
    expect(() =>
      inspectImageBytes(jpeg.slice(0, frameOffset + 2 + frameLength), 'image/jpeg'),
    ).toThrow('INVALID_IMAGE');
    expect(() => inspectImageBytes(jpeg.slice(0, -2), 'image/jpeg')).toThrow('INVALID_IMAGE');
  });

  it('1枚8MiBを超える画像を拒否する', () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    expect(() => inspectImageBytes(oversized, 'image/png')).toThrow('IMAGE_TOO_LARGE');
  });
});
