import { afterEach, expect, it, vi } from 'vitest';
import { jstToday } from './date';

afterEach(() => vi.useRealTimers());

it('reads the current JST date after midnight even with a reused formatter', () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-11-04T14:59:59.999Z');
  expect(jstToday()).toBe('2026-11-04');
  vi.setSystemTime('2026-11-04T15:00:00.000Z');
  expect(jstToday()).toBe('2026-11-05');
});
