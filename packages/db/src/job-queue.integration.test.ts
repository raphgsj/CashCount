import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  JobQueueRepository,
  QueueLeaseLostError,
  queueWorkerCapability,
  systemQueueCapability,
} from './job-queue-repository.js';
import { runMigrations } from './migrations.js';
import { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_queue_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected queue test database identifier.');
  }
  return `"${identifier}"`;
}

function instant(value: string): Date {
  return new Date(value);
}

describe('PostgreSQL job queue repository', () => {
  it('deduplicates, claims concurrently, heartbeats, retries, reclaims, and dead-letters safely', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_queue_${randomUUID().replaceAll('-', '')}`;
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: databaseUrl });

    try {
      await admin.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(testUrl.toString());
      await seedSyntheticIdentity(testUrl.toString(), 'test');
      const pool = new Pool({ connectionString: testUrl.toString() });
      pool.on('error', () => undefined);

      try {
        const repository = new JobQueueRepository(pool);
        const workspaceId = syntheticIdentitySeed.workspace.id;
        const queuedAt = instant('2026-08-24T00:00:00.000Z');
        const connectionId = '30000000-0000-4000-8000-000000000001';
        const concurrentDedupe = await Promise.all(
          Array.from({ length: 12 }, () =>
            repository.enqueueWorkspace(workspaceId, {
              availableAt: queuedAt,
              dedupeKey: 'sync-connection:synthetic',
              jobType: 'SYNC_CONNECTION',
              maxAttempts: 3,
              payload: { providerConnectionId: connectionId },
              priority: 100,
            }),
          ),
        );
        expect(concurrentDedupe.filter(({ created }) => created)).toHaveLength(1);
        expect(new Set(concurrentDedupe.map(({ id }) => id)).size).toBe(1);

        const secondWorkspaceId = '20000000-0000-4000-8000-000000000002';
        await pool.query(`insert into workspace (id, name) values ($1, 'Second Queue Workspace')`, [
          secondWorkspaceId,
        ]);
        expect(
          await repository.enqueueWorkspace(secondWorkspaceId, {
            availableAt: instant('2026-08-25T00:00:00.000Z'),
            dedupeKey: 'sync-connection:synthetic',
            jobType: 'SYNC_CONNECTION',
            maxAttempts: 3,
            payload: { providerConnectionId: connectionId },
          }),
        ).toHaveProperty('created', true);

        await expect(
          repository.enqueueWorkspace(workspaceId, {
            jobType: 'SYNC_CONNECTION',
            maxAttempts: 3,
            payload: { rawPayload: connectionId },
          }),
        ).rejects.toThrow(/internal Id/u);
        expect(() =>
          repository.enqueueSystem({} as never, {
            jobType: 'REPROCESS_RAW_OBJECT',
            maxAttempts: 3,
          }),
        ).toThrow(/capability/u);

        const unsupportedForInitialWorker = await repository.enqueueSystem(systemQueueCapability, {
          availableAt: queuedAt,
          dedupeKey: 'webhook:registered-type-filter',
          jobType: 'PROCESS_WEBHOOK',
          maxAttempts: 3,
          payload: { webhookEventId: '50000000-0000-4000-8000-000000000010' },
          priority: 1_000,
        });

        const initialClaim = await repository.claim(queueWorkerCapability, {
          jobTypes: ['SYNC_CONNECTION'],
          now: queuedAt,
          workerId: 'worker-initial',
        });
        expect(initialClaim).toMatchObject({
          attemptCount: 1,
          jobType: 'SYNC_CONNECTION',
          leaseExpiresAt: instant('2026-08-24T00:02:00.000Z'),
          startedAt: queuedAt,
          status: 'RUNNING',
        });
        if (initialClaim === null) throw new Error('Expected initial queue claim.');
        const runningDedupe = await Promise.all(
          Array.from({ length: 12 }, () =>
            repository.enqueueWorkspace(workspaceId, {
              availableAt: queuedAt,
              dedupeKey: 'sync-connection:synthetic',
              jobType: 'SYNC_CONNECTION',
              maxAttempts: 3,
              payload: { providerConnectionId: connectionId },
              priority: 100,
            }),
          ),
        );
        expect(runningDedupe.every(({ created }) => !created)).toBe(true);
        expect(new Set(runningDedupe.map(({ id }) => id))).toEqual(new Set([initialClaim.id]));
        await expect(
          repository.complete(
            queueWorkerCapability,
            initialClaim.id,
            'worker-wrong',
            instant('2026-08-24T00:00:01.000Z'),
          ),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);
        expect(
          await repository.heartbeat(
            queueWorkerCapability,
            initialClaim.id,
            'worker-initial',
            instant('2026-08-24T00:00:30.000Z'),
            1_000,
          ),
        ).toEqual(instant('2026-08-24T00:02:00.000Z'));
        expect(
          await repository.heartbeat(
            queueWorkerCapability,
            initialClaim.id,
            'worker-initial',
            instant('2026-08-24T00:00:30.000Z'),
          ),
        ).toEqual(instant('2026-08-24T00:02:30.000Z'));
        await expect(
          repository.heartbeat(
            queueWorkerCapability,
            initialClaim.id,
            'worker-initial',
            instant('2026-08-24T00:00:29.000Z'),
          ),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);
        await expect(
          repository.complete(
            queueWorkerCapability,
            initialClaim.id,
            'worker-initial',
            instant('2026-08-24T00:00:29.000Z'),
          ),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);
        await repository.complete(
          queueWorkerCapability,
          initialClaim.id,
          'worker-initial',
          instant('2026-08-24T00:00:31.000Z'),
        );
        await expect(
          repository.complete(
            queueWorkerCapability,
            initialClaim.id,
            'worker-initial',
            instant('2026-08-24T00:00:32.000Z'),
          ),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);

        const registeredTypeClaim = await repository.claim(queueWorkerCapability, {
          jobTypes: ['PROCESS_WEBHOOK'],
          now: instant('2026-08-24T00:00:33.000Z'),
          workerId: 'worker-registered-webhook',
        });
        expect(registeredTypeClaim?.id).toBe(unsupportedForInitialWorker.id);
        if (registeredTypeClaim === null) throw new Error('Expected registered-type queue claim.');
        await repository.complete(
          queueWorkerCapability,
          registeredTypeClaim.id,
          'worker-registered-webhook',
          instant('2026-08-24T00:00:34.000Z'),
        );

        const replacement = await repository.enqueueWorkspace(workspaceId, {
          availableAt: instant('2026-08-25T00:00:00.000Z'),
          dedupeKey: 'sync-connection:synthetic',
          jobType: 'SYNC_CONNECTION',
          maxAttempts: 3,
          payload: { providerConnectionId: connectionId },
        });
        expect(replacement.created).toBe(true);

        const concurrentIds = Array.from(
          { length: 16 },
          (_, index) => `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        );
        await Promise.all(
          concurrentIds.map((financialAccountId, index) =>
            repository.enqueueWorkspace(workspaceId, {
              availableAt: instant('2026-08-24T01:00:00.000Z'),
              dedupeKey: `sync-account:${index}`,
              jobType: 'SYNC_ACCOUNT',
              maxAttempts: 3,
              payload: { financialAccountId },
              priority: index,
            }),
          ),
        );
        const concurrentClaims = await Promise.all(
          Array.from({ length: 24 }, (_, index) =>
            repository
              .claim(queueWorkerCapability, {
                leaseDurationMs: 10_000,
                now: instant('2026-08-24T01:00:00.000Z'),
                workerId: `worker-concurrent-${index}`,
              })
              .then((job) => ({ job, workerId: `worker-concurrent-${index}` })),
          ),
        );
        const claimed = concurrentClaims.filter(
          (entry): entry is { job: NonNullable<typeof entry.job>; workerId: string } =>
            entry.job !== null,
        );
        expect(claimed).toHaveLength(16);
        expect(new Set(claimed.map(({ job }) => job.id)).size).toBe(16);
        await Promise.all(
          claimed.map(({ job, workerId }) =>
            repository.complete(
              queueWorkerCapability,
              job.id,
              workerId,
              instant('2026-08-24T01:00:01.000Z'),
            ),
          ),
        );

        const retryJob = await repository.enqueueSystem(systemQueueCapability, {
          availableAt: instant('2026-08-24T02:00:00.000Z'),
          dedupeKey: 'raw-object:retry',
          jobType: 'REPROCESS_RAW_OBJECT',
          maxAttempts: 2,
          payload: { providerRawObjectId: '50000000-0000-4000-8000-000000000001' },
          priority: 200,
        });
        const retryClaimOne = await repository.claim(queueWorkerCapability, {
          leaseDurationMs: 10_000,
          now: instant('2026-08-24T02:00:00.000Z'),
          workerId: 'worker-retry-one',
        });
        expect(retryClaimOne?.id).toBe(retryJob.id);
        if (retryClaimOne === null) throw new Error('Expected retry claim one.');
        expect(
          await repository.fail(queueWorkerCapability, {
            errorCode: 'PROVIDER_UNAVAILABLE',
            jobId: retryClaimOne.id,
            now: instant('2026-08-24T02:00:01.000Z'),
            redactedSummary: 'Provider temporarily unavailable.',
            retryAt: instant('2026-08-24T02:00:05.000Z'),
            workerId: 'worker-retry-one',
          }),
        ).toBe('RETRY');
        expect(
          await repository.claim(queueWorkerCapability, {
            now: instant('2026-08-24T02:00:04.999Z'),
            workerId: 'worker-too-early',
          }),
        ).toBeNull();
        const retryClaimTwo = await repository.claim(queueWorkerCapability, {
          leaseDurationMs: 10_000,
          now: instant('2026-08-24T02:00:05.000Z'),
          workerId: 'worker-retry-two',
        });
        expect(retryClaimTwo).toMatchObject({ attemptCount: 2, id: retryJob.id });
        if (retryClaimTwo === null) throw new Error('Expected retry claim two.');
        expect(
          await repository.fail(queueWorkerCapability, {
            errorCode: 'PROVIDER_UNAVAILABLE',
            jobId: retryClaimTwo.id,
            now: instant('2026-08-24T02:00:06.000Z'),
            redactedSummary: 'Provider still unavailable.',
            retryAt: instant('2026-08-24T02:00:10.000Z'),
            workerId: 'worker-retry-two',
          }),
        ).toBe('DEAD');

        const reclaimJob = await repository.enqueueWorkspace(workspaceId, {
          availableAt: instant('2026-08-24T03:00:00.000Z'),
          dedupeKey: 'sync-connection:reclaim',
          jobType: 'SYNC_CONNECTION',
          maxAttempts: 3,
          payload: { providerConnectionId: connectionId },
          priority: 300,
        });
        const staleClaim = await repository.claim(queueWorkerCapability, {
          leaseDurationMs: 1_000,
          now: instant('2026-08-24T03:00:00.000Z'),
          workerId: 'worker-stale',
        });
        expect(staleClaim?.id).toBe(reclaimJob.id);
        expect(
          await repository.reclaimExpired(queueWorkerCapability, {
            now: instant('2026-08-24T03:00:00.999Z'),
          }),
        ).toEqual([]);
        if (staleClaim === null) throw new Error('Expected stale queue claim.');
        await expect(
          repository.heartbeat(
            queueWorkerCapability,
            staleClaim.id,
            'worker-stale',
            instant('2026-08-24T03:00:01.000Z'),
          ),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);
        await expect(
          repository.complete(
            queueWorkerCapability,
            staleClaim.id,
            'worker-stale',
            instant('2026-08-24T03:00:01.000Z'),
          ),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);
        await expect(
          repository.fail(queueWorkerCapability, {
            errorCode: 'LEASE_EXPIRED',
            jobId: staleClaim.id,
            now: instant('2026-08-24T03:00:01.000Z'),
            redactedSummary: 'The worker lease expired.',
            retryAt: instant('2026-08-24T03:00:02.000Z'),
            workerId: 'worker-stale',
          }),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);
        expect(
          await repository.reclaimExpired(queueWorkerCapability, {
            now: instant('2026-08-24T03:00:01.000Z'),
            retryAtForAttempt: () => instant('2026-08-24T03:00:01.500Z'),
          }),
        ).toEqual([{ attemptCount: 1, id: reclaimJob.id, status: 'RETRY' }]);
        await expect(
          repository.complete(
            queueWorkerCapability,
            reclaimJob.id,
            'worker-stale',
            instant('2026-08-24T03:00:01.000Z'),
          ),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);
        const reclaimedClaim = await repository.claim(queueWorkerCapability, {
          leaseDurationMs: 10_000,
          now: instant('2026-08-24T03:00:01.500Z'),
          workerId: 'worker-reclaimed',
        });
        expect(reclaimedClaim).toMatchObject({ attemptCount: 2, id: reclaimJob.id });
        if (reclaimedClaim === null) throw new Error('Expected reclaimed claim.');
        await expect(
          repository.complete(
            queueWorkerCapability,
            reclaimedClaim.id,
            'worker-stale',
            instant('2026-08-24T03:00:02.000Z'),
          ),
        ).rejects.toBeInstanceOf(QueueLeaseLostError);
        await repository.complete(
          queueWorkerCapability,
          reclaimedClaim.id,
          'worker-reclaimed',
          instant('2026-08-24T03:00:02.000Z'),
        );

        const exhausted = await repository.enqueueSystem(systemQueueCapability, {
          availableAt: instant('2026-08-24T04:00:00.000Z'),
          dedupeKey: 'raw-object:expired-once',
          jobType: 'REPROCESS_RAW_OBJECT',
          maxAttempts: 1,
          payload: { providerRawObjectId: '50000000-0000-4000-8000-000000000002' },
          priority: 400,
        });
        await repository.claim(queueWorkerCapability, {
          leaseDurationMs: 1_000,
          now: instant('2026-08-24T04:00:00.000Z'),
          workerId: 'worker-exhausted',
        });
        expect(
          await repository.reclaimExpired(queueWorkerCapability, {
            now: instant('2026-08-24T04:00:01.000Z'),
          }),
        ).toEqual([{ attemptCount: 1, id: exhausted.id, status: 'DEAD' }]);

        const statusRows = await pool.query<{
          attempt_count: number;
          finished_at: Date;
          last_error_code: string;
          status: string;
        }>(
          `select status, attempt_count, finished_at, last_error_code
           from job_queue where id in ($1::uuid, $2::uuid) order by id`,
          [retryJob.id, exhausted.id],
        );
        expect(statusRows.rows).toHaveLength(2);
        expect(statusRows.rows.every(({ status }) => status === 'DEAD')).toBe(true);
        expect(statusRows.rows.every(({ finished_at }) => finished_at instanceof Date)).toBe(true);
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)} with (force)`);
      await admin.end();
    }
  }, 30_000);
});
