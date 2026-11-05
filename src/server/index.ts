import { createApp } from './app';
import { consumeGenerationQueue, reconcileGenerationQueue } from './generation-queue';
import { cleanRetainedEntriesForScheduledEnvironment } from './retention-cleanup';
import { createScheduledHandler } from './scheduled-handler';
import type { GenerationQueueBatch } from './generation-queue';
import type { Environment } from './mode';
import type { OpenAIGenerationRuntime } from './openai-generation-runner';

export function createWorker(runtime: OpenAIGenerationRuntime = {}) {
  const app = createApp({
    localDevelopment: import.meta.env.DEV,
    saveGeneratedComic: runtime.saveGeneratedComic,
    recoverGeneratedComic: runtime.recoverGeneratedComic,
  });
  const scheduled = createScheduledHandler({
    reconcileGenerationQueue: (environment) =>
      reconcileGenerationQueue(environment, undefined, runtime),
    cleanRetainedEntries: cleanRetainedEntriesForScheduledEnvironment,
  });

  return {
    fetch: app.fetch,
    queue: (batch: GenerationQueueBatch, environment: Environment) =>
      consumeGenerationQueue(batch, environment, undefined, runtime),
    scheduled,
  };
}

export default createWorker();
