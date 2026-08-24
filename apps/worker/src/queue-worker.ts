import {
  defaultQueueHeartbeatMs,
  defaultQueueLeaseMs,
  QueueLeaseLostError,
  queueJobTypes,
  queueWorkerCapability,
  type ClaimedQueueJob,
  type JobQueueRepository,
  type QueueJobType,
} from '@cashcount/db';

export const defaultWorkerConcurrency = 4;
export const defaultWorkerPollIntervalMs = 1_000;

export interface QueueJobExecutionContext {
  signal: AbortSignal;
  workerId: string;
}

export type QueueJobHandler = (
  job: ClaimedQueueJob,
  context: QueueJobExecutionContext,
) => Promise<void>;

export type QueueJobHandlers = Readonly<Partial<Record<QueueJobType, QueueJobHandler>>>;

export interface QueueWorkerOperationalEvent {
  code:
    | 'QUEUE_CLAIM_FAILED'
    | 'QUEUE_COMPLETE_FAILED'
    | 'QUEUE_FAILURE_RECORD_FAILED'
    | 'QUEUE_HEARTBEAT_FAILED'
    | 'QUEUE_LEASE_LOST'
    | 'QUEUE_PROCESS_FAILED'
    | 'QUEUE_RECLAIM_FAILED';
  jobId?: string;
}

export interface PersistentQueueWorkerOptions {
  concurrency?: number;
  handlers: QueueJobHandlers;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  now?: () => Date;
  onOperationalEvent?: (event: QueueWorkerOperationalEvent) => void;
  pollIntervalMs?: number;
  queue: Pick<JobQueueRepository, 'claim' | 'complete' | 'fail' | 'heartbeat' | 'reclaimExpired'>;
  random?: () => number;
  workerId: string;
}

interface QueueJobFailureOptions {
  errorCode: string;
  redactedSummary: string;
  retryable: boolean;
}

export class QueueJobFailure extends Error {
  public readonly errorCode: string;
  public readonly redactedSummary: string;
  public readonly retryable: boolean;

  public constructor(options: QueueJobFailureOptions) {
    super(options.redactedSummary);
    if (!/^[A-Z][A-Z0-9_]{0,99}$/u.test(options.errorCode)) {
      throw new TypeError('Queue job failure code must be a bounded uppercase machine code.');
    }
    if (
      options.redactedSummary.trim() !== options.redactedSummary ||
      options.redactedSummary.length === 0 ||
      options.redactedSummary.length > 1_000 ||
      [...options.redactedSummary].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      })
    ) {
      throw new TypeError('Queue job failure summary must contain 1 to 1000 safe characters.');
    }
    this.name = 'QueueJobFailure';
    this.errorCode = options.errorCode;
    this.redactedSummary = options.redactedSummary;
    this.retryable = options.retryable;
  }
}

function requireBoundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function requireWorkerId(workerId: string): void {
  if (workerId.trim() !== workerId || workerId.length === 0 || workerId.length > 200) {
    throw new TypeError('workerId must contain 1 to 200 trimmed characters.');
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function retryAt(now: Date, attemptCount: number, random: () => number): Date {
  const randomValue = random();
  const boundedRandom = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  const exponentialMs = Math.min(300_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
  const jitteredMs = Math.max(1_000, Math.round(exponentialMs * (0.75 + boundedRandom * 0.5)));
  return new Date(now.getTime() + Math.min(300_000, jitteredMs));
}

export class PersistentQueueWorker {
  readonly #concurrency: number;
  readonly #handlers: QueueJobHandlers;
  readonly #heartbeatIntervalMs: number;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #jobTypes: readonly QueueJobType[];
  readonly #leaseDurationMs: number;
  readonly #now: () => Date;
  readonly #onOperationalEvent: ((event: QueueWorkerOperationalEvent) => void) | undefined;
  readonly #pollIntervalMs: number;
  readonly #queue: PersistentQueueWorkerOptions['queue'];
  readonly #random: () => number;
  readonly #workerId: string;
  #pollController: AbortController | undefined;
  #started = false;
  #stopRequested = false;

  public constructor(options: PersistentQueueWorkerOptions) {
    const concurrency = options.concurrency ?? defaultWorkerConcurrency;
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? defaultQueueHeartbeatMs;
    const leaseDurationMs = options.leaseDurationMs ?? defaultQueueLeaseMs;
    const pollIntervalMs = options.pollIntervalMs ?? defaultWorkerPollIntervalMs;
    requireBoundedInteger('concurrency', concurrency, 1, 64);
    requireBoundedInteger('heartbeatIntervalMs', heartbeatIntervalMs, 1, 300_000);
    requireBoundedInteger('leaseDurationMs', leaseDurationMs, 1_000, 900_000);
    requireBoundedInteger('pollIntervalMs', pollIntervalMs, 1, 60_000);
    if (heartbeatIntervalMs >= leaseDurationMs) {
      throw new TypeError('heartbeatIntervalMs must be shorter than leaseDurationMs.');
    }
    requireWorkerId(options.workerId);

    const handlers: QueueJobHandlers = Object.freeze({ ...options.handlers });
    const handlerKeys = Object.keys(handlers);
    if (handlerKeys.some((jobType) => !queueJobTypes.includes(jobType as QueueJobType))) {
      throw new TypeError('Queue worker handlers contain an unsupported job type.');
    }

    this.#concurrency = concurrency;
    this.#handlers = handlers;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#jobTypes = handlerKeys as QueueJobType[];
    this.#leaseDurationMs = leaseDurationMs;
    this.#now = options.now ?? (() => new Date());
    this.#onOperationalEvent = options.onOperationalEvent;
    this.#pollIntervalMs = pollIntervalMs;
    this.#queue = options.queue;
    this.#random = options.random ?? Math.random;
    this.#workerId = options.workerId;
  }

  public get activeJobCount(): number {
    return this.#inFlight.size;
  }

  public get isStopping(): boolean {
    return this.#stopRequested;
  }

  public requestStop(): void {
    this.#stopRequested = true;
    this.#pollController?.abort();
  }

  public async run(): Promise<void> {
    if (this.#started) throw new Error('Persistent queue worker can run only once.');
    this.#started = true;

    while (!this.#stopRequested) {
      await this.#reclaimExpired();
      const claimed = await this.#fillCapacity();
      if (this.#stopRequested) break;

      const active = [...this.#inFlight];
      if (active.length >= this.#concurrency) {
        await Promise.race(active);
      } else if (!claimed) {
        this.#pollController = new AbortController();
        await abortableDelay(this.#pollIntervalMs, this.#pollController.signal);
        this.#pollController = undefined;
      }
    }

    await Promise.all(this.#inFlight);
  }

  async #fillCapacity(): Promise<boolean> {
    if (this.#jobTypes.length === 0) return false;
    let claimed = false;

    while (!this.#stopRequested && this.#inFlight.size < this.#concurrency) {
      let job: ClaimedQueueJob | null;
      try {
        job = await this.#queue.claim(queueWorkerCapability, {
          jobTypes: this.#jobTypes,
          leaseDurationMs: this.#leaseDurationMs,
          now: this.#now(),
          workerId: this.#workerId,
        });
      } catch {
        this.#report({ code: 'QUEUE_CLAIM_FAILED' });
        return claimed;
      }
      if (job === null) return claimed;
      claimed = true;
      const task = this.#process(job).catch(() => {
        this.#report({ code: 'QUEUE_PROCESS_FAILED', jobId: job.id });
      });
      this.#inFlight.add(task);
      void task.finally(() => this.#inFlight.delete(task));
    }

    return claimed;
  }

  async #process(job: ClaimedQueueJob): Promise<void> {
    const handler = this.#handlers[job.jobType];
    if (handler === undefined) return;
    const handlerController = new AbortController();
    let leaseLost = false;
    const heartbeatController = new AbortController();
    const heartbeat = (async (): Promise<void> => {
      while (!heartbeatController.signal.aborted) {
        await abortableDelay(this.#heartbeatIntervalMs, heartbeatController.signal);
        if (heartbeatController.signal.aborted) return;
        try {
          await this.#queue.heartbeat(
            queueWorkerCapability,
            job.id,
            this.#workerId,
            this.#now(),
            this.#leaseDurationMs,
          );
        } catch (error) {
          if (error instanceof QueueLeaseLostError) {
            leaseLost = true;
            handlerController.abort();
            this.#report({ code: 'QUEUE_LEASE_LOST', jobId: job.id });
            return;
          }
          this.#report({ code: 'QUEUE_HEARTBEAT_FAILED', jobId: job.id });
        }
      }
    })();

    let handlerError: unknown;
    try {
      await handler(job, { signal: handlerController.signal, workerId: this.#workerId });
    } catch (error) {
      handlerError = error;
    } finally {
      heartbeatController.abort();
      await heartbeat;
    }

    if (leaseLost) return;
    const now = this.#now();
    if (handlerError === undefined) {
      try {
        await this.#queue.complete(queueWorkerCapability, job.id, this.#workerId, now);
      } catch (error) {
        this.#report({
          code: error instanceof QueueLeaseLostError ? 'QUEUE_LEASE_LOST' : 'QUEUE_COMPLETE_FAILED',
          jobId: job.id,
        });
      }
      return;
    }

    const failure =
      handlerError instanceof QueueJobFailure
        ? handlerError
        : new QueueJobFailure({
            errorCode: 'UNEXPECTED_HANDLER_ERROR',
            redactedSummary: 'Job handler failed unexpectedly.',
            retryable: false,
          });
    try {
      await this.#queue.fail(queueWorkerCapability, {
        errorCode: failure.errorCode,
        jobId: job.id,
        now,
        redactedSummary: failure.redactedSummary,
        retryAt: failure.retryable ? retryAt(now, job.attemptCount, this.#random) : null,
        workerId: this.#workerId,
      });
    } catch (error) {
      this.#report({
        code:
          error instanceof QueueLeaseLostError ? 'QUEUE_LEASE_LOST' : 'QUEUE_FAILURE_RECORD_FAILED',
        jobId: job.id,
      });
    }
  }

  async #reclaimExpired(): Promise<void> {
    try {
      await this.#queue.reclaimExpired(queueWorkerCapability, {
        limit: Math.max(100, this.#concurrency * 4),
        now: this.#now(),
      });
    } catch {
      this.#report({ code: 'QUEUE_RECLAIM_FAILED' });
    }
  }

  #report(event: QueueWorkerOperationalEvent): void {
    try {
      this.#onOperationalEvent?.(event);
    } catch {
      // Observability must never change queue ownership behavior.
    }
  }
}
