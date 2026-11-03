import type { Environment } from './mode';

export const GENERATION_RECONCILE_CRON = '* * * * *';
export const RETENTION_CLEANUP_CRON = '0 15 * * *';

export type ScheduledEvent = {
  scheduledTime: number;
  cron: string;
};

export type ScheduledExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type ScheduledTasks = {
  reconcileGenerationQueue(environment: Environment): Promise<unknown>;
  cleanRetainedEntries(environment: Environment): Promise<unknown>;
};

export function createScheduledHandler(tasks: ScheduledTasks) {
  return (
    event: ScheduledEvent,
    environment: Environment,
    context: ScheduledExecutionContext,
  ): void => {
    const task =
      event.cron === GENERATION_RECONCILE_CRON
        ? tasks.reconcileGenerationQueue
        : event.cron === RETENTION_CLEANUP_CRON
          ? tasks.cleanRetainedEntries
          : undefined;
    if (!task) return;

    let promise: Promise<unknown>;
    try {
      promise = task(environment);
    } catch (error) {
      promise = Promise.reject(error);
    }
    context.waitUntil(promise);
  };
}
