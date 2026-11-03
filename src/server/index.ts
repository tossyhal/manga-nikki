import { createApp } from './app';
import { consumeGenerationQueue, reconcileGenerationQueue } from './generation-queue';
import type { GenerationQueueBatch } from './generation-queue';
import type { Environment } from './mode';
const app = createApp({ localDevelopment: import.meta.env.DEV });

type ScheduledEvent = { scheduledTime: number };
type WorkerExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export default {
  fetch: app.fetch,
  queue: (batch: GenerationQueueBatch, environment: Environment) =>
    consumeGenerationQueue(batch, environment),
  scheduled: (_event: ScheduledEvent, environment: Environment, context: WorkerExecutionContext) =>
    context.waitUntil(reconcileGenerationQueue(environment)),
};
