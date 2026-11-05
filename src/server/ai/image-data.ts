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
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('INVALID_IMAGE');
  }
  validateImageBytes(bytes, mime);
  return bytes;
}

export type ImageDimensions = Readonly<{ width: number; height: number }>;

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    (bytes[offset + 1]! << 8) +
    (bytes[offset + 2]! << 16) +
    bytes[offset + 3]! * 0x1000000
  );
}

function positiveDimensions(width: number, height: number): ImageDimensions {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 2048 ||
    height > 2048 ||
    width * height > 4_194_304
  )
    throw new Error('INVALID_IMAGE');
  return { width, height };
}

const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1)
    crc = pngCrcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validPngHeader(bytes: Uint8Array): boolean {
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  if (bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) return false;
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16].includes(bitDepth);
    case 2:
      return bitDepth === 8 || bitDepth === 16;
    case 3:
      return [1, 2, 4, 8].includes(bitDepth);
    case 4:
    case 6:
      return bitDepth === 8 || bitDepth === 16;
    default:
      return false;
  }
}

function pngDimensions(bytes: Uint8Array): ImageDimensions {
  if (
    bytes.byteLength < 45 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ||
    readUint32BigEndian(bytes, 8) !== 13 ||
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82 ||
    pngCrc32(bytes, 12, 29) !== readUint32BigEndian(bytes, 29) ||
    !validPngHeader(bytes)
  )
    throw new Error('INVALID_IMAGE');

  const dimensions = positiveDimensions(
    readUint32BigEndian(bytes, 16),
    readUint32BigEndian(bytes, 20),
  );
  let offset = 8;
  let hasHeader = false;
  let hasImageData = false;
  let hasImageDataChunk = false;
  let imageDataEnded = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32BigEndian(bytes, offset);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + length + 4;
    if (nextOffset > bytes.byteLength) throw new Error('INVALID_IMAGE');
    const crcOffset = dataOffset + length;
    if (pngCrc32(bytes, offset + 4, crcOffset) !== readUint32BigEndian(bytes, crcOffset))
      throw new Error('INVALID_IMAGE');
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (!/^[A-Za-z]{4}$/.test(type) || (type.charCodeAt(2)! & 0x20) !== 0)
      throw new Error('INVALID_IMAGE');
    if (!hasHeader) {
      if (type !== 'IHDR' || length !== 13) throw new Error('INVALID_IMAGE');
      hasHeader = true;
    } else if (type === 'IHDR') {
      throw new Error('INVALID_IMAGE');
    }
    if (type === 'IDAT') {
      if (imageDataEnded) throw new Error('INVALID_IMAGE');
      hasImageDataChunk = true;
      if (length > 0) hasImageData = true;
    } else if (hasImageDataChunk && type !== 'IEND') {
      imageDataEnded = true;
    }
    if (type === 'IEND') {
      if (
        length !== 0 ||
        !hasImageData ||
        readUint32BigEndian(bytes, dataOffset) !== 0xae426082 ||
        nextOffset !== bytes.byteLength
      )
        throw new Error('INVALID_IMAGE');
      return dimensions;
    }
    offset = nextOffset;
  }
  throw new Error('INVALID_IMAGE');
}

function isJpegStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
    marker,
  );
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error('INVALID_IMAGE');

  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  let componentCount = 0;
  let hasScanData = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) throw new Error('INVALID_IMAGE');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00 || marker === 0xd8)
      throw new Error('INVALID_IMAGE');
    if (marker === 0xd9) {
      if (!dimensions || !hasScanData || offset !== bytes.byteLength)
        throw new Error('INVALID_IMAGE');
      return dimensions;
    }
    if (marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) throw new Error('INVALID_IMAGE');
    if (offset + 2 > bytes.byteLength) throw new Error('INVALID_IMAGE');

    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength)
      throw new Error('INVALID_IMAGE');
    if (isJpegStartOfFrame(marker)) {
      if (dimensions || segmentLength < 8) throw new Error('INVALID_IMAGE');
      componentCount = bytes[offset + 7]!;
      if (componentCount < 1 || componentCount > 4 || segmentLength !== 8 + 3 * componentCount)
        throw new Error('INVALID_IMAGE');
      dimensions = positiveDimensions(
        readUint16BigEndian(bytes, offset + 5),
        readUint16BigEndian(bytes, offset + 3),
      );
    }
    if (marker === 0xda) {
      const scanComponentCount = bytes[offset + 2]!;
      if (
        !dimensions ||
        scanComponentCount < 1 ||
        scanComponentCount > componentCount ||
        segmentLength !== 6 + 2 * scanComponentCount
      )
        throw new Error('INVALID_IMAGE');

      offset += segmentLength;
      let scanLength = 0;
      let nextMarkerFound = false;
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          scanLength += 1;
          continue;
        }
        const markerOffset = offset;
        while (bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.byteLength) throw new Error('INVALID_IMAGE');
        const scanMarker = bytes[offset]!;
        if (scanMarker === 0x00) {
          offset += 1;
          scanLength += 1;
        } else if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          offset += 1;
        } else {
          offset = markerOffset;
          nextMarkerFound = true;
          break;
        }
      }
      if (!nextMarkerFound) throw new Error('INVALID_IMAGE');
      if (scanLength > 0) hasScanData = true;
      continue;
    }
    offset += segmentLength;
  }
  throw new Error('INVALID_IMAGE');
}

function webpDimensions(bytes: Uint8Array): ImageDimensions {
  if (
    bytes.byteLength < 20 ||
    bytes[0] !== 82 ||
    bytes[1] !== 73 ||
    bytes[2] !== 70 ||
    bytes[3] !== 70 ||
    bytes[8] !== 87 ||
    bytes[9] !== 69 ||
    bytes[10] !== 66 ||
    bytes[11] !== 80
  )
    throw new Error('INVALID_IMAGE');

  const riffEnd = readUint32LittleEndian(bytes, 4) + 8;
  if (riffEnd !== bytes.byteLength || riffEnd < 20) throw new Error('INVALID_IMAGE');
  let offset = 12;
  let canvasDimensions: ImageDimensions | null = null;
  while (offset + 8 <= riffEnd) {
    const tag = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const length = readUint32LittleEndian(bytes, offset + 4);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + length + (length % 2);
    if (nextOffset > riffEnd) throw new Error('INVALID_IMAGE');

    if (tag === 'VP8X') {
      if (offset !== 12 || length !== 10 || canvasDimensions) throw new Error('INVALID_IMAGE');
      canvasDimensions = positiveDimensions(
        readUint24LittleEndian(bytes, dataOffset + 4) + 1,
        readUint24LittleEndian(bytes, dataOffset + 7) + 1,
      );
      offset = nextOffset;
      continue;
    }
    if (tag === 'VP8 ') {
      if (
        length < 10 ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      )
        throw new Error('INVALID_IMAGE');
      const width = readUint16LittleEndian(bytes, dataOffset + 6) & 0x3fff;
      const height = readUint16LittleEndian(bytes, dataOffset + 8) & 0x3fff;
      const imageDimensions = positiveDimensions(width, height);
      if (
        (canvasDimensions &&
          (canvasDimensions.width !== imageDimensions.width ||
            canvasDimensions.height !== imageDimensions.height)) ||
        nextOffset !== riffEnd
      )
        throw new Error('INVALID_IMAGE');
      return imageDimensions;
    }
    if (tag === 'VP8L') {
      if (length < 5 || bytes[dataOffset] !== 0x2f) throw new Error('INVALID_IMAGE');
      const width = bytes[dataOffset + 1]! | ((bytes[dataOffset + 2]! & 0x3f) << 8);
      const height =
        ((bytes[dataOffset + 2]! & 0xc0) >> 6) |
        (bytes[dataOffset + 3]! << 2) |
        ((bytes[dataOffset + 4]! & 0x0f) << 10);
      const imageDimensions = positiveDimensions(width + 1, height + 1);
      if (
        (canvasDimensions &&
          (canvasDimensions.width !== imageDimensions.width ||
            canvasDimensions.height !== imageDimensions.height)) ||
        nextOffset !== riffEnd
      )
        throw new Error('INVALID_IMAGE');
      return imageDimensions;
    }
    offset = nextOffset;
  }
  throw new Error('INVALID_IMAGE');
}

export function inspectImageBytes(bytes: Uint8Array, mime: string | undefined): ImageDimensions {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
  if (mime === 'image/png') return pngDimensions(bytes);
  if (mime === 'image/jpeg') return jpegDimensions(bytes);
  if (mime === 'image/webp') return webpDimensions(bytes);
  throw new Error('INVALID_IMAGE');
}

export function validateImageBytes(
  bytes: Uint8Array,
  mime: string | undefined,
): asserts bytes is RenderedPanel['data'] {
  inspectImageBytes(bytes, mime);
}
