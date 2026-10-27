import { describe, expect, it } from 'vitest';
import { comicSchema, createEntrySchema, jstToday } from './schemas';
import { pageComic, panelsComic } from './fixtures';
describe('shared v1 schemas', () => {
  it('accepts both documentation fixtures', () => {
    expect(comicSchema.safeParse(pageComic).success).toBe(true);
    expect(comicSchema.safeParse(panelsComic).success).toBe(true);
  });
  it('rejects missing/duplicate panels, unknown keys and duplicate asset IDs', () => {
    expect(comicSchema.safeParse({ ...pageComic, panels: pageComic.panels.slice(1) }).success).toBe(
      false,
    );
    expect(
      comicSchema.safeParse({
        ...pageComic,
        panels: [pageComic.panels[0], ...pageComic.panels.slice(0, 3)],
      }).success,
    ).toBe(false);
    expect(comicSchema.safeParse({ ...pageComic, ownerId: 'unexpected' }).success).toBe(false);
    expect(
      comicSchema.safeParse({
        ...panelsComic,
        visual: {
          kind: 'panels',
          textMode: 'external',
          assetIds: Array(4).fill(crypto.randomUUID()),
        },
      }).success,
    ).toBe(false);
  });
  it('counts Unicode codepoints, validates dates, and rejects blank diary text', () => {
    const base = {
      createRequestId: crypto.randomUUID(),
      diaryDate: jstToday(),
      body: '😀'.repeat(1000),
      consentVersion: 'v1',
    };
    expect(createEntrySchema.safeParse(base).success).toBe(true);
    expect(createEntrySchema.safeParse({ ...base, body: '😀'.repeat(1001) }).success).toBe(false);
    expect(createEntrySchema.safeParse({ ...base, body: '  ' }).success).toBe(false);
    expect(createEntrySchema.safeParse({ ...base, diaryDate: '2025-02-30' }).success).toBe(false);
    expect(createEntrySchema.safeParse({ ...base, diaryDate: '2099-01-01' }).success).toBe(false);
  });
});
