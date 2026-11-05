import { describe, expect, it } from 'vitest';
import { summarizeDiary } from './summary';

describe('summarizeDiary', () => {
  it('uses the first sentence as a header', () => {
    expect(summarizeDiary('図書館で本を読んだ。帰り道で猫を見かけた。')).toBe(
      '図書館で本を読んだ。',
    );
  });
  it('keeps a short diary as-is and truncates long text', () => {
    expect(summarizeDiary('  短い一日  ')).toBe('短い一日');
    expect([...summarizeDiary('あ'.repeat(80))].length).toBe(40);
    expect(summarizeDiary('あ'.repeat(80)).endsWith('…')).toBe(true);
  });
  it('does not execute markup in the summary', () => {
    expect(summarizeDiary('<script>window.injected=true</script>')).toBe(
      '<script>window.injected=true</script>',
    );
  });
});
