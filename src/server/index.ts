import { createApp } from './app';
import { consumeGenerationQueue, reconcileGenerationQueue } from './generation-queue';
import { cleanRetainedEntriesForScheduledEnvironment } from './retention-cleanup';
import { createScheduledHandler } from './scheduled-handler';
import type { GenerationQueueBatch } from './generation-queue';
import type { Environment } from './mode';
const app = createApp({ localDevelopment: import.meta.env.DEV });

const scheduled = createScheduledHandler({
  reconcileGenerationQueue,
  cleanRetainedEntries: cleanRetainedEntriesForScheduledEnvironment,
});

export default {
  fetch: app.fetch,
  queue: (batch: GenerationQueueBatch, environment: Environment) =>
    consumeGenerationQueue(batch, environment),
  scheduled,
};
