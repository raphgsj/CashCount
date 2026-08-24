import type { ClaimedQueueJob, ReconciliationRepository } from '@cashcount/db';
import { PluggyHttpError } from '@cashcount/provider-pluggy';

import { QueueJobFailure, type QueueJobHandler } from './queue-worker.js';
import {
  ReconciliationAbortedError,
  ReconciliationPollingTimeoutError,
  runConnectionReconciliation,
  type ScheduledReconciliationOptions,
} from './scheduled-reconciliation.js';

export interface ManualReconciliationHandlerOptions extends Omit<
  ScheduledReconciliationOptions,
  'reconciliationRunId' | 'signal' | 'workspaceId'
> {
  persistence: ScheduledReconciliationOptions['persistence'] &
    Pick<ReconciliationRepository, 'getEnabledConnection'>;
}

function providerConnectionId(job: ClaimedQueueJob): string {
  const value = job.payload['providerConnectionId'];
  if (
    job.jobType !== 'SYNC_CONNECTION' ||
    job.workspaceId === null ||
    Object.keys(job.payload).length !== 1 ||
    typeof value !== 'string'
  ) {
    throw new QueueJobFailure({
      errorCode: 'INVALID_SYNC_CONNECTION_JOB',
      redactedSummary: 'Connection reconciliation job scope or payload is invalid.',
      retryable: false,
    });
  }
  return value;
}

function retryable(error: unknown): boolean {
  if (
    error instanceof ReconciliationAbortedError ||
    error instanceof ReconciliationPollingTimeoutError
  ) {
    return true;
  }
  if (error instanceof PluggyHttpError) return error.status === 429 || error.status >= 500;
  if (error instanceof TypeError || error instanceof RangeError) return false;
  if (error instanceof Error && error.name.endsWith('InvariantError')) return false;
  return true;
}

export function createManualReconciliationHandler(
  options: ManualReconciliationHandlerOptions,
): QueueJobHandler {
  return async (job, context) => {
    const connectionId = providerConnectionId(job);
    const workspaceId = job.workspaceId;
    if (workspaceId === null) throw new Error('Validated connection job lost its workspace.');
    try {
      const target = await options.persistence.getEnabledConnection(workspaceId, connectionId);
      if (target === null) {
        throw new QueueJobFailure({
          errorCode: 'CONNECTION_NOT_AVAILABLE',
          redactedSummary: 'Connection is unavailable for manual reconciliation.',
          retryable: false,
        });
      }
      await runConnectionReconciliation(
        {
          ...options,
          reconciliationRunId: job.id,
          signal: context.signal,
          workspaceId,
        },
        target,
      );
    } catch (error) {
      if (error instanceof QueueJobFailure) throw error;
      throw new QueueJobFailure({
        errorCode: 'MANUAL_RECONCILIATION_FAILED',
        redactedSummary: 'Manual connection reconciliation did not complete.',
        retryable: retryable(error),
      });
    }
  };
}
