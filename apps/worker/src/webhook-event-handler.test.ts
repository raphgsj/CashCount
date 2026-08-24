import {
  PayloadEncryptionService,
  type ClaimedQueueJob,
  type TransactionImportAccount,
  type WebhookProcessingEvent,
} from '@cashcount/db';
import type { ProviderConnectionDto } from '@cashcount/provider-core';
import { PluggyHttpError } from '@cashcount/provider-pluggy';
import { describe, expect, it, vi } from 'vitest';

import { QueueJobFailure } from './queue-worker.js';
import {
  createPluggyWebhookHandler,
  type PluggyWebhookHandlerOptions,
} from './webhook-event-handler.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const webhookId = '20000000-0000-4000-8000-000000000001';
const itemId = '30000000-0000-4000-8000-000000000001';
const connectionId = '40000000-0000-4000-8000-000000000001';
const accountId = '50000000-0000-4000-8000-000000000001';
const financialAccountId = '60000000-0000-4000-8000-000000000001';
const eventId = '70000000-0000-4000-8000-000000000001';
const transactionId = '80000000-0000-4000-8000-000000000001';
const syncRunId = '90000000-0000-4000-8000-000000000001';

const now = new Date('2026-08-24T12:00:00.000Z');

function job(mapped = true): ClaimedQueueJob {
  return {
    attemptCount: 1,
    availableAt: now,
    dedupeKey: `webhook-event:${webhookId}`,
    heartbeatAt: now,
    id: 'a0000000-0000-4000-8000-000000000001',
    jobType: 'PROCESS_WEBHOOK',
    leaseExpiresAt: new Date('2026-08-24T12:02:00.000Z'),
    maxAttempts: 8,
    payload: { webhookEventId: webhookId },
    priority: 0,
    startedAt: now,
    status: 'RUNNING',
    workspaceId: mapped ? workspaceId : null,
  };
}

function stored(payload: unknown, status: WebhookProcessingEvent['status'] = 'QUEUED') {
  const account =
    typeof payload === 'object' && payload !== null && 'accountId' in payload
      ? String(payload.accountId)
      : null;
  return {
    eventType:
      typeof payload === 'object' && payload !== null && 'event' in payload
        ? String(payload.event)
        : 'item/updated',
    externalAccountId: account,
    externalConnectionId: itemId,
    externalEventId: eventId,
    id: webhookId,
    payload,
    status,
    workspaceId: status === 'UNMAPPED' ? null : workspaceId,
  } satisfies WebhookProcessingEvent;
}

function connection(localStatus: ProviderConnectionDto['localStatus']): ProviderConnectionDto {
  return {
    actionRequiredAt: null,
    consentExpiresAt: null,
    displayName: 'Synthetic Bank',
    errorCode: localStatus === 'REAUTH_REQUIRED' ? 'LOGIN_ERROR' : null,
    executionStatus: localStatus === 'ACTIVE' ? 'SUCCESS' : 'ERROR',
    externalConnectionId: itemId,
    externalConnectorId: '601',
    itemStatus: localStatus === 'ACTIVE' ? 'UPDATED' : 'LOGIN_ERROR',
    localStatus,
    providerUpdatedAt: now.toISOString(),
    raw: { synthetic: true },
  };
}

const account: TransactionImportAccount = {
  accountCurrency: 'BRL',
  accountType: 'CHECKING',
  externalAccountId: accountId,
  financialAccountId,
};

function fixture(event: string): Record<string, unknown> {
  const common = { event, eventId, itemId };
  if (event === 'transactions/created') {
    return {
      ...common,
      accountId,
      createdTransactionsLinkV2:
        `https://api.pluggy.ai/v2/transactions?accountId=${accountId}` +
        '&createdAtFrom=2026-08-24T10:00:00.000Z',
      transactionsCount: 0,
      transactionsCreatedAtFrom: '2026-08-24T10:00:00.000Z',
    };
  }
  if (event === 'transactions/updated' || event === 'transactions/deleted') {
    return { ...common, accountId, transactionIds: [transactionId], transactionsCount: 1 };
  }
  if (event === 'item/error') return { ...common, error: { code: 'LOGIN_ERROR' } };
  return common;
}

interface Harness {
  calls: string[];
  handler: ReturnType<typeof createPluggyWebhookHandler>;
  listCursors: (null | string)[];
  options: PluggyWebhookHandlerOptions;
}

function harness(payload: unknown, snapshot = connection('ACTIVE')): Harness {
  const calls: string[] = [];
  const listCursors: (null | string)[] = [];
  const event = stored(payload);
  const options: PluggyWebhookHandlerOptions = {
    applyConnectionSnapshot: async () => {
      calls.push(`apply:${snapshot.localStatus}`);
    },
    encryption: new PayloadEncryptionService({
      activeKeyVersion: 1,
      keyring: new Map([[1, new Uint8Array(32).fill(43)]]),
    }),
    fullImport: async () => {
      calls.push('full-import');
    },
    now: () => now,
    provider: {
      getConnection: async () => {
        calls.push('get-item');
        return snapshot;
      },
      listTransactions: async (input) => {
        calls.push('list-transactions');
        listCursors.push(input.cursor);
        return { items: [], nextCursor: null };
      },
    },
    providerBaseUrl: 'https://api.pluggy.ai',
    replacementDetector: {
      detectForSync: async () => {
        calls.push('detect-replacements');
        return {
          autoConfirmed: 0,
          candidatesInserted: 0,
          candidatesSeen: 0,
          needsReview: 0,
          stateTransfersCompleted: 0,
        };
      },
    },
    transactionPersistence: {
      completeSync: async () => {
        calls.push('complete-sync');
        return {
          accountsSeen: 1,
          syncRunId,
          transactionsDeleted: 0,
          transactionsInserted: 0,
          transactionsSeen: 0,
          transactionsUpdated: 0,
        };
      },
      deleteWebhookTransactions: async () => {
        calls.push('soft-delete');
        return 1;
      },
      failSync: async () => {
        calls.push('fail-sync');
      },
      importPage: async () => {
        calls.push('import-page');
        return {
          rawSnapshotsInserted: 0,
          transactionsDeleted: 0,
          transactionsInserted: 0,
          transactionsSeen: 0,
          transactionsUpdated: 0,
        };
      },
      startWebhookSync: async () => {
        calls.push('start-sync');
        return { accounts: [account], syncRunId };
      },
    },
    webhookPersistence: {
      load: async () => event,
      markConnectionDeleted: async () => {
        calls.push('mark-deleted');
      },
      markConnectionSyncing: async () => {
        calls.push('mark-syncing');
      },
      markFailed: async () => {
        calls.push('mark-failed');
      },
      markProcessed: async () => {
        calls.push('mark-processed');
      },
      recordLifecycleAlert: async () => {
        calls.push('record-alert');
      },
      resolveConnection: async () => {
        calls.push('resolve-connection');
        return { localStatus: 'ACTIVE', providerConnectionId: connectionId };
      },
      withConnectionLock: async (_workspaceId, _externalConnectionId, action) => action(),
    },
  };
  return { calls, handler: createPluggyWebhookHandler(options), listCursors, options };
}

const context = { signal: new AbortController().signal, workerId: 'worker-test' };

describe('Pluggy webhook event handler', () => {
  it('keeps a successful item update SYNCING until its full import succeeds', async () => {
    const test = harness(fixture('item/updated'));

    await test.handler(job(), context);

    expect(test.calls).toEqual([
      'resolve-connection',
      'mark-syncing',
      'get-item',
      'full-import',
      'apply:ACTIVE',
      'mark-processed',
    ]);
  });

  it('uses the current Item state and records an idempotent owner action alert', async () => {
    const test = harness(fixture('item/error'), connection('REAUTH_REQUIRED'));

    await test.handler(job(), context);

    expect(test.calls).toEqual([
      'resolve-connection',
      'get-item',
      'apply:REAUTH_REQUIRED',
      'record-alert',
      'mark-processed',
    ]);
  });

  it('marks item deletion locally without making an expected-to-404 provider call', async () => {
    const test = harness(fixture('item/deleted'));
    const getConnection = vi.spyOn(test.options.provider, 'getConnection');

    await test.handler(job(), context);

    expect(getConnection).not.toHaveBeenCalled();
    expect(test.calls).toEqual(['resolve-connection', 'mark-deleted', 'mark-processed']);
  });

  it.each([
    ['transactions/created', 'createdAtFrom'],
    ['transactions/updated', 'ids'],
  ])(
    'imports %s with the documented V2 filter and then detects replacements',
    async (event, key) => {
      const test = harness(fixture(event));

      await test.handler(job(), context);

      expect(test.listCursors[0]).toContain(`accountId=${accountId}`);
      expect(test.listCursors[0]).toContain(key);
      expect(test.calls).toEqual([
        'resolve-connection',
        'start-sync',
        'list-transactions',
        'import-page',
        'complete-sync',
        'detect-replacements',
        'mark-processed',
      ]);
    },
  );

  it('refreshes the current V2 account before soft deletion so replacements share one sync window', async () => {
    const test = harness(fixture('transactions/deleted'));

    await test.handler(job(), context);

    expect(test.listCursors).toEqual([null]);
    expect(test.calls).toEqual([
      'resolve-connection',
      'start-sync',
      'list-transactions',
      'import-page',
      'soft-delete',
      'complete-sync',
      'detect-replacements',
      'mark-processed',
    ]);
  });

  it('records only a redacted failure code and retries transient provider failures', async () => {
    const test = harness(fixture('item/updated'));
    test.options.provider.getConnection = async () => {
      throw new PluggyHttpError('GET', `/items/${itemId}`, 503);
    };
    const handler = createPluggyWebhookHandler(test.options);

    const failure = await handler(job(), context).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(QueueJobFailure);
    expect(failure).toMatchObject({
      errorCode: 'WEBHOOK_PROCESSING_FAILED',
      redactedSummary: 'Webhook event processing failed.',
      retryable: true,
    });
    expect(test.calls).toContain('mark-failed');
  });

  it('completes unmapped inbox work without decrypting or contacting Pluggy', async () => {
    const test = harness(fixture('item/updated'));
    test.options.webhookPersistence.load = async () =>
      stored(null, 'UNMAPPED') as WebhookProcessingEvent;
    const handler = createPluggyWebhookHandler(test.options);

    await handler(job(false), context);

    expect(test.calls).toEqual([]);
  });

  it('ignores stale transaction work after a connection has been deleted', async () => {
    const test = harness(fixture('transactions/updated'));
    test.options.webhookPersistence.resolveConnection = async () => ({
      localStatus: 'DELETED',
      providerConnectionId: connectionId,
    });
    const handler = createPluggyWebhookHandler(test.options);

    await handler(job(), context);

    expect(test.calls).toEqual(['mark-processed']);
  });
});
