import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { mockEnvironment } from './mode';
import {
  createScheduledHandler,
  GENERATION_RECONCILE_CRON,
  RETENTION_CLEANUP_CRON,
} from './scheduled-handler';

function executionContext() {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    context: { waitUntil: vi.fn((promise: Promise<unknown>) => promises.push(promise)) },
  };
}

describe('scheduled handler', () => {
  it('declares the same generation and retention crons in the local-connected Wrangler environment', async () => {
    const source = await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
    const config = JSON.parse(source.replace(/,\s*([}\]])/g, '$1')) as {
      env: Record<string, { triggers?: { crons?: string[] } }>;
    };

    expect(config.env['local-connected']?.triggers?.crons).toEqual([
      GENERATION_RECONCILE_CRON,
      RETENTION_CLEANUP_CRON,
    ]);
    expect(config.env.staging?.triggers?.crons).toEqual([RETENTION_CLEANUP_CRON]);
    expect(config.env.production?.triggers?.crons).toEqual([RETENTION_CLEANUP_CRON]);
  });

  it('runs only generation reconciliation for the one-minute cron', async () => {
    const reconcileGenerationQueue = vi.fn(async () => undefined);
    const cleanRetainedEntries = vi.fn(async () => undefined);
    const handler = createScheduledHandler({ reconcileGenerationQueue, cleanRetainedEntries });
    const execution = executionContext();

    handler(
      { scheduledTime: 1, cron: GENERATION_RECONCILE_CRON },
      mockEnvironment,
      execution.context,
    );

    expect(reconcileGenerationQueue).toHaveBeenCalledExactlyOnceWith(mockEnvironment);
    expect(cleanRetainedEntries).not.toHaveBeenCalled();
    expect(execution.context.waitUntil).toHaveBeenCalledOnce();
    await expect(execution.promises[0]).resolves.toBeUndefined();
  });

  it('runs only retention cleanup for the daily cron', async () => {
    const reconcileGenerationQueue = vi.fn(async () => undefined);
    const cleanRetainedEntries = vi.fn(async () => ({ deleted: 1 }));
    const handler = createScheduledHandler({ reconcileGenerationQueue, cleanRetainedEntries });
    const execution = executionContext();

    handler({ scheduledTime: 1, cron: RETENTION_CLEANUP_CRON }, mockEnvironment, execution.context);

    expect(cleanRetainedEntries).toHaveBeenCalledExactlyOnceWith(mockEnvironment);
    expect(reconcileGenerationQueue).not.toHaveBeenCalled();
    expect(execution.context.waitUntil).toHaveBeenCalledOnce();
    await expect(execution.promises[0]).resolves.toEqual({ deleted: 1 });
  });

  it('does not schedule work for an unknown cron expression', () => {
    const reconcileGenerationQueue = vi.fn(async () => undefined);
    const cleanRetainedEntries = vi.fn(async () => undefined);
    const handler = createScheduledHandler({ reconcileGenerationQueue, cleanRetainedEntries });
    const execution = executionContext();

    handler({ scheduledTime: 1, cron: '0 0 * * 7' }, mockEnvironment, execution.context);

    expect(reconcileGenerationQueue).not.toHaveBeenCalled();
    expect(cleanRetainedEntries).not.toHaveBeenCalled();
    expect(execution.context.waitUntil).not.toHaveBeenCalled();
  });

  it('registers failures with waitUntil without swallowing the scheduled outcome', async () => {
    const failure = new Error('scheduled dependency failed');
    const reconcileGenerationQueue = vi.fn(() => Promise.reject(failure));
    const cleanRetainedEntries = vi.fn(async () => undefined);
    const handler = createScheduledHandler({ reconcileGenerationQueue, cleanRetainedEntries });
    const execution = executionContext();

    handler(
      { scheduledTime: 1, cron: GENERATION_RECONCILE_CRON },
      mockEnvironment,
      execution.context,
    );

    await expect(execution.promises[0]).rejects.toBe(failure);
  });
});
