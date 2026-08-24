import { EventEmitter } from 'node:events';

import type { ClaimedQueueJob, QueueJobType } from '@cashcount/db';
import { describe, expect, it } from 'vitest';

import {
  PersistentQueueWorker,
  QueueJobFailure,
  type PersistentQueueWorkerOptions,
} from './queue-worker.js';
import { runUntilTermination } from './worker-process.js';

function claimedJob(index: number, jobType: QueueJobType = 'PROCESS_WEBHOOK'): ClaimedQueueJob {
  const suffix = String(index).padStart(12, '0');
  const now = new Date('2026-08-24T10:00:00.000Z');
  return {
    attemptCount: 1,
    availableAt: now,
    dedupeKey: `job:${index}`,
    heartbeatAt: now,
    id: `60000000-0000-4000-8000-${suffix}`,
    jobType,
    leaseExpiresAt: new Date('2026-08-24T10:02:00.000Z'),
    maxAttempts: 3,
    payload: { webhookEventId: `70000000-0000-4000-8000-${suffix}` },
    priority: 0,
    startedAt: now,
    status: 'RUNNING',
    workspaceId: '10000000-0000-4000-8000-000000000001',
  };
}

interface FakeQueueState {
  claimInputs: { jobTypes: readonly QueueJobType[] | undefined }[];
  completedIds: string[];
  failed: {
    errorCode: string;
    redactedSummary: string;
    retryAt: Date | null;
  }[];
  heartbeatCount: number;
  operations: string[];
}

function fakeQueue(
  jobs: ClaimedQueueJob[],
  state: FakeQueueState,
): PersistentQueueWorkerOptions['queue'] {
  const pending = [...jobs];
  return {
    async claim(_capability, input) {
      state.operations.push('claim');
      state.claimInputs.push({ jobTypes: input.jobTypes });
      return pending.shift() ?? null;
    },
    async complete(_capability, jobId) {
      state.completedIds.push(jobId);
    },
    async fail(_capability, input) {
      state.failed.push({
        errorCode: input.errorCode,
        redactedSummary: input.redactedSummary,
        retryAt: input.retryAt,
      });
      return input.retryAt === null ? 'DEAD' : 'RETRY';
    },
    async heartbeat() {
      state.heartbeatCount += 1;
      return new Date('2026-08-24T10:02:00.000Z');
    },
    async reclaimExpired() {
      state.operations.push('reclaim');
      return [];
    },
  };
}

function emptyState(): FakeQueueState {
  return {
    claimInputs: [],
    completedIds: [],
    failed: [],
    heartbeatCount: 0,
    operations: [],
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for worker test condition.');
}

describe('persistent queue worker', () => {
  it('recovers stale work, filters registered types, heartbeats, and bounds concurrency', async () => {
    const jobs = Array.from({ length: 5 }, (_, index) => claimedJob(index + 1));
    const state = emptyState();
    let active = 0;
    let maximumActive = 0;
    const queue = fakeQueue(jobs, state);
    const originalComplete = queue.complete.bind(queue);
    queue.complete = async (...parameters) => {
      await originalComplete(...parameters);
      if (state.completedIds.length === jobs.length) worker.requestStop();
    };
    const worker = new PersistentQueueWorker({
      concurrency: 2,
      handlers: {
        PROCESS_WEBHOOK: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
        },
      },
      heartbeatIntervalMs: 5,
      leaseDurationMs: 1_000,
      pollIntervalMs: 5,
      queue,
      workerId: 'worker-bounded',
    });

    await worker.run();

    expect(state.operations[0]).toBe('reclaim');
    expect(state.claimInputs.every(({ jobTypes }) => jobTypes?.[0] === 'PROCESS_WEBHOOK')).toBe(
      true,
    );
    expect(state.completedIds).toHaveLength(5);
    expect(maximumActive).toBe(2);
    expect(state.heartbeatCount).toBeGreaterThan(0);
    expect(worker.activeJobCount).toBe(0);
  });

  it('stops claiming on SIGTERM and drains owned work before returning', async () => {
    const state = emptyState();
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted = false;
    const worker = new PersistentQueueWorker({
      concurrency: 1,
      handlers: {
        PROCESS_WEBHOOK: async () => {
          handlerStarted = true;
          await handlerGate;
        },
      },
      heartbeatIntervalMs: 10,
      leaseDurationMs: 1_000,
      pollIntervalMs: 5,
      queue: fakeQueue([claimedJob(10)], state),
      workerId: 'worker-sigterm',
    });
    const signals = new EventEmitter();
    let stopped = false;
    const running = runUntilTermination(worker, signals).then(() => {
      stopped = true;
    });
    await waitUntil(() => handlerStarted);

    signals.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(worker.isStopping).toBe(true);
    expect(stopped).toBe(false);
    expect(state.claimInputs).toHaveLength(1);

    releaseHandler?.();
    await running;
    expect(state.completedIds).toEqual([claimedJob(10).id]);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('retries only explicitly transient failures and stores redacted summaries', async () => {
    const state = emptyState();
    const jobs = [claimedJob(20), claimedJob(21)];
    let handled = 0;
    const queue = fakeQueue(jobs, state);
    const originalFail = queue.fail.bind(queue);
    queue.fail = async (...parameters) => {
      const status = await originalFail(...parameters);
      if (state.failed.length === jobs.length) worker.requestStop();
      return status;
    };
    const worker = new PersistentQueueWorker({
      concurrency: 1,
      handlers: {
        PROCESS_WEBHOOK: async () => {
          handled += 1;
          if (handled === 1) {
            throw new QueueJobFailure({
              errorCode: 'PROVIDER_UNAVAILABLE',
              redactedSummary: 'Provider temporarily unavailable.',
              retryable: true,
            });
          }
          throw new Error('sensitive upstream detail');
        },
      },
      heartbeatIntervalMs: 10,
      leaseDurationMs: 1_000,
      now: () => new Date('2026-08-24T11:00:00.000Z'),
      pollIntervalMs: 5,
      queue,
      random: () => 0.5,
      workerId: 'worker-failures',
    });

    await worker.run();

    expect(state.failed).toEqual([
      {
        errorCode: 'PROVIDER_UNAVAILABLE',
        redactedSummary: 'Provider temporarily unavailable.',
        retryAt: new Date('2026-08-24T11:00:01.000Z'),
      },
      {
        errorCode: 'UNEXPECTED_HANDLER_ERROR',
        redactedSummary: 'Job handler failed unexpectedly.',
        retryAt: null,
      },
    ]);
    expect(JSON.stringify(state.failed)).not.toContain('sensitive upstream detail');
  });
});
