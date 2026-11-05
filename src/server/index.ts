import { createApp } from './app';
import { consumeGenerationQueue, reconcileGenerationQueue } from './generation-queue';
import { cleanRetainedEntriesForScheduledEnvironment } from './retention-cleanup';
import { createScheduledHandler } from './scheduled-handler';
import type { GenerationQueueBatch } from './generation-queue';
import type { Environment } from './mode';
import type { OpenAIGenerationRuntime } from './openai-generation-runner';
import { createGenerationSaveRuntime } from './comic-save-runtime';

export function createWorker(runtime: OpenAIGenerationRuntime = {}) {
  const effectiveRuntime: OpenAIGenerationRuntime = {
    ...createGenerationSaveRuntime(),
    ...runtime,
  };
  const app = createApp({
    localDevelopment: import.meta.env.DEV,
    saveGeneratedComic: effectiveRuntime.saveGeneratedComic,
    recoverGeneratedComic: effectiveRuntime.recoverGeneratedComic,
  });
  const scheduled = createScheduledHandler({
    reconcileGenerationQueue: (environment) =>
      reconcileGenerationQueue(environment, undefined, effectiveRuntime),
    cleanRetainedEntries: cleanRetainedEntriesForScheduledEnvironment,
  });

  return {
    fetch: app.fetch,
    queue: (batch: GenerationQueueBatch, environment: Environment) =>
      consumeGenerationQueue(batch, environment, undefined, effectiveRuntime),
    scheduled,
  };
}

export default createWorker();
