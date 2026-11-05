import { describe, expect, it } from 'vitest';
import { inspectImageBytes, validateImageBytes } from './image-data';

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
);

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  return new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    0x24,
    0x00,
    0x00,
    0x00,
    0x57,
    0x45,
    0x42,
    0x50,
    0x56,
    0x50,
    0x38,
    0x58,
    0x0a,
    0x00,
    0x00,
    0x00,
    0,
    0,
    0,
    0,
    widthMinusOne & 0xff,
    (widthMinusOne >> 8) & 0xff,
    (widthMinusOne >> 16) & 0xff,
    heightMinusOne & 0xff,
    (heightMinusOne >> 8) & 0xff,
    (heightMinusOne >> 16) & 0xff,
    0x56,
    0x50,
    0x38,
    0x4c,
    0x05,
    0x00,
    0x00,
    0x00,
    0x2f,
    widthMinusOne & 0xff,
    ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6),
    (heightMinusOne >> 2) & 0xff,
    (heightMinusOne >> 10) & 0x0f,
    0x00,
  ]);
}

describe('画像バイナリ検証', () => {
  it('PNG・JPEG・WebPのシグネチャと寸法を読む', () => {
    expect(inspectImageBytes(png, 'image/png')).toEqual({ width: 1, height: 1 });
    expect(inspectImageBytes(jpeg(320, 240), 'image/jpeg')).toEqual({ width: 320, height: 240 });
    expect(inspectImageBytes(webpVp8x(640, 480), 'image/webp')).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('MIME・シグネチャ・寸法が一致しない画像を拒否する', () => {
    expect(() => inspectImageBytes(png, 'image/jpeg')).toThrow('INVALID_IMAGE');
    expect(() => inspectImageBytes(new Uint8Array([1, 2, 3]), 'image/png')).toThrow(
      'INVALID_IMAGE',
    );
    expect(() => inspectImageBytes(jpeg(0, 10), 'image/jpeg')).toThrow('INVALID_IMAGE');
    expect(() => inspectImageBytes(webpVp8x(1, 1).slice(0, 24), 'image/webp')).toThrow(
      'INVALID_IMAGE',
    );
    expect(() => validateImageBytes(png, 'image/png')).not.toThrow();
  });

  it('1枚8MiBを超える画像を拒否する', () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    expect(() => inspectImageBytes(oversized, 'image/png')).toThrow('IMAGE_TOO_LARGE');
  });
});
