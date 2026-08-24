import type {
  ClaimedQueueJob,
  PayloadEncryptionService,
  TransactionImportAccount,
  TransactionImportRepository,
  TransactionReplacementRepository,
  WebhookProcessingEvent,
  WebhookProcessingRepository,
} from '@cashcount/db';
import type { ProviderConnectionDto } from '@cashcount/provider-core';
import {
  normalizePluggyCreatedTransactionsHint,
  pluggyTransactionIdsInput,
  PluggyHttpError,
  pluggyWebhookPayloadSchema,
  type PluggyDataClient,
  type PluggyWebhookPayload,
} from '@cashcount/provider-pluggy';

import { QueueJobFailure, type QueueJobExecutionContext } from './queue-worker.js';

const actionableStatuses = new Set([
  'PROVIDER_ERROR',
  'REAUTH_REQUIRED',
  'USER_ACTION_REQUIRED',
  'USER_INPUT_REQUIRED',
] as const);

type ActionableStatus =
  'PROVIDER_ERROR' | 'REAUTH_REQUIRED' | 'USER_ACTION_REQUIRED' | 'USER_INPUT_REQUIRED';

export interface PluggyWebhookHandlerOptions {
  applyConnectionSnapshot(
    workspaceId: string,
    providerConnectionId: string,
    snapshot: ProviderConnectionDto,
  ): Promise<void>;
  encryption: PayloadEncryptionService;
  fullImport(workspaceId: string, providerConnectionId: string): Promise<unknown>;
  now?: () => Date;
  provider: Pick<PluggyDataClient, 'getConnection' | 'listTransactions'>;
  providerBaseUrl: string;
  replacementDetector: Pick<TransactionReplacementRepository, 'detectForSync'>;
  transactionPersistence: Pick<
    TransactionImportRepository,
    'completeSync' | 'deleteWebhookTransactions' | 'failSync' | 'importPage' | 'startWebhookSync'
  >;
  webhookPersistence: Pick<
    WebhookProcessingRepository,
    | 'load'
    | 'markConnectionDeleted'
    | 'markConnectionSyncing'
    | 'markFailed'
    | 'markProcessed'
    | 'recordLifecycleAlert'
    | 'resolveConnection'
    | 'withConnectionLock'
  >;
}

function webhookEventId(job: ClaimedQueueJob): string {
  const keys = Object.keys(job.payload);
  const value = job.payload['webhookEventId'];
  if (keys.length !== 1 || typeof value !== 'string') {
    throw new QueueJobFailure({
      errorCode: 'INVALID_WEBHOOK_JOB_PAYLOAD',
      redactedSummary: 'Webhook job payload is invalid.',
      retryable: false,
    });
  }
  return value;
}

function assertEventMetadata(stored: WebhookProcessingEvent, payload: PluggyWebhookPayload): void {
  if (
    stored.eventType !== payload.event ||
    stored.externalEventId !== payload.eventId ||
    stored.externalConnectionId !== payload.itemId ||
    stored.externalAccountId !== ('accountId' in payload ? payload.accountId : null)
  ) {
    throw new TypeError('Webhook envelope metadata does not match its payload.');
  }
}

function abortIfRequested(context: QueueJobExecutionContext): void {
  if (context.signal.aborted) {
    throw new QueueJobFailure({
      errorCode: 'WEBHOOK_PROCESSING_ABORTED',
      redactedSummary: 'Webhook processing was interrupted.',
      retryable: true,
    });
  }
}

function retryableFailure(error: unknown): boolean {
  if (error instanceof QueueJobFailure) return error.retryable;
  if (error instanceof PluggyHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof TypeError || error instanceof RangeError) return false;
  if (
    error instanceof Error &&
    (error.name.endsWith('InvariantError') ||
      error.name === 'PayloadAuthenticationError' ||
      error.name === 'MissingEncryptionKeyError' ||
      error.name === 'PluggyResponseValidationError' ||
      error.name === 'ZodError')
  ) {
    return false;
  }
  return true;
}

async function recordActionAlert(
  options: PluggyWebhookHandlerOptions,
  workspaceId: string,
  providerConnectionId: string,
  webhookId: string,
  status: ProviderConnectionDto['localStatus'],
): Promise<void> {
  if (!actionableStatuses.has(status as ActionableStatus)) return;
  await options.webhookPersistence.recordLifecycleAlert(
    workspaceId,
    providerConnectionId,
    webhookId,
    status as ActionableStatus,
    options.now?.() ?? new Date(),
  );
}

async function processItemEvent(
  options: PluggyWebhookHandlerOptions,
  stored: WebhookProcessingEvent,
  payload: PluggyWebhookPayload,
  workspaceId: string,
  context: QueueJobExecutionContext,
): Promise<void> {
  return options.webhookPersistence.withConnectionLock(
    workspaceId,
    stored.externalConnectionId,
    async () => {
      const target = await options.webhookPersistence.resolveConnection(
        workspaceId,
        stored.externalConnectionId,
      );
      abortIfRequested(context);
      if (payload.event === 'item/deleted') {
        await options.webhookPersistence.markConnectionDeleted(
          workspaceId,
          target.providerConnectionId,
          options.now?.() ?? new Date(),
        );
        return;
      }
      if (target.localStatus === 'DELETED' || target.localStatus === 'DISABLED') return;

      if (
        payload.event === 'item/created' ||
        payload.event === 'item/updated' ||
        payload.event === 'item/login_succeeded'
      ) {
        await options.webhookPersistence.markConnectionSyncing(
          workspaceId,
          target.providerConnectionId,
          options.now?.() ?? new Date(),
        );
      }

      let snapshot: ProviderConnectionDto;
      try {
        snapshot = await options.provider.getConnection(stored.externalConnectionId);
      } catch (error) {
        if (error instanceof PluggyHttpError && error.status === 404) {
          await options.webhookPersistence.markConnectionDeleted(
            workspaceId,
            target.providerConnectionId,
            options.now?.() ?? new Date(),
          );
          return;
        }
        throw error;
      }
      if (snapshot.externalConnectionId !== stored.externalConnectionId) {
        throw new TypeError('Provider returned a different Item identity.');
      }
      abortIfRequested(context);

      if (snapshot.localStatus === 'ACTIVE') {
        await options.fullImport(workspaceId, target.providerConnectionId);
        abortIfRequested(context);
      }
      await options.applyConnectionSnapshot(workspaceId, target.providerConnectionId, snapshot);
      await recordActionAlert(
        options,
        workspaceId,
        target.providerConnectionId,
        stored.id,
        snapshot.localStatus,
      );
    },
  );
}

async function importTransactionPages(
  options: PluggyWebhookHandlerOptions,
  workspaceId: string,
  syncRunId: string,
  account: TransactionImportAccount,
  initialCursor: null | string,
  context: QueueJobExecutionContext,
): Promise<void> {
  let cursor = initialCursor;
  const requested = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (page > 10_000) throw new RangeError('Webhook transaction pagination exceeded its limit.');
    abortIfRequested(context);
    if (cursor !== null) {
      if (requested.has(cursor)) throw new TypeError('Webhook transaction cursor repeated.');
      requested.add(cursor);
    }
    const result = await options.provider.listTransactions({
      cursor,
      externalAccountId: account.externalAccountId,
    });
    if (result.nextCursor !== null && requested.has(result.nextCursor)) {
      throw new TypeError('Webhook transaction cursor formed a cycle.');
    }
    await options.transactionPersistence.importPage(
      workspaceId,
      syncRunId,
      account,
      result.items,
      result.nextCursor,
      options.encryption,
      options.now?.() ?? new Date(),
    );
    if (result.nextCursor === null) return;
    cursor = result.nextCursor;
  }
}

async function processTransactionEvent(
  options: PluggyWebhookHandlerOptions,
  stored: WebhookProcessingEvent,
  payload: Extract<PluggyWebhookPayload, { accountId: string }>,
  workspaceId: string,
  context: QueueJobExecutionContext,
): Promise<void> {
  return options.webhookPersistence.withConnectionLock(
    workspaceId,
    stored.externalConnectionId,
    async () => {
      const target = await options.webhookPersistence.resolveConnection(
        workspaceId,
        stored.externalConnectionId,
      );
      if (target.localStatus === 'DELETED' || target.localStatus === 'DISABLED') return;
      const started = await options.transactionPersistence.startWebhookSync(
        workspaceId,
        target.providerConnectionId,
        payload.accountId,
        options.now?.() ?? new Date(),
      );
      const account = started.accounts[0];
      if (account === undefined || started.accounts.length !== 1) {
        throw new TypeError('Webhook transaction sync did not resolve one account.');
      }

      try {
        const initial =
          payload.event === 'transactions/created'
            ? normalizePluggyCreatedTransactionsHint(
                {
                  accountId: payload.accountId,
                  ...(payload.createdTransactionsLink === undefined
                    ? {}
                    : { createdTransactionsLink: payload.createdTransactionsLink }),
                  ...(payload.createdTransactionsLinkV2 === undefined
                    ? {}
                    : { createdTransactionsLinkV2: payload.createdTransactionsLinkV2 }),
                  transactionsCreatedAtFrom: payload.transactionsCreatedAtFrom,
                },
                options.providerBaseUrl,
              ).cursor
            : payload.event === 'transactions/updated'
              ? pluggyTransactionIdsInput(payload.accountId, payload.transactionIds).cursor
              : null;
        await importTransactionPages(
          options,
          workspaceId,
          started.syncRunId,
          account,
          initial,
          context,
        );
        if (payload.event === 'transactions/deleted') {
          await options.transactionPersistence.deleteWebhookTransactions(
            workspaceId,
            started.syncRunId,
            account,
            payload.transactionIds,
            options.now?.() ?? new Date(),
          );
        }
        await options.transactionPersistence.completeSync(
          workspaceId,
          started.syncRunId,
          options.now?.() ?? new Date(),
        );
      } catch (error) {
        await options.transactionPersistence.failSync(
          workspaceId,
          started.syncRunId,
          options.now?.() ?? new Date(),
        );
        throw error;
      }
      await options.replacementDetector.detectForSync(
        workspaceId,
        started.syncRunId,
        options.now?.() ?? new Date(),
      );
    },
  );
}

export function createPluggyWebhookHandler(options: PluggyWebhookHandlerOptions) {
  return async (job: ClaimedQueueJob, context: QueueJobExecutionContext): Promise<void> => {
    const id = webhookEventId(job);
    let stored: WebhookProcessingEvent | undefined;
    try {
      stored = await options.webhookPersistence.load(job.workspaceId, id, options.encryption);
      if (
        stored.status === 'PROCESSED' ||
        stored.status === 'IGNORED' ||
        stored.status === 'UNMAPPED'
      ) {
        return;
      }
      if (stored.workspaceId === null || stored.payload === null) {
        throw new TypeError('Mapped webhook processing data is incomplete.');
      }
      const payload = pluggyWebhookPayloadSchema.parse(stored.payload);
      assertEventMetadata(stored, payload);
      abortIfRequested(context);
      if (
        payload.event === 'transactions/created' ||
        payload.event === 'transactions/updated' ||
        payload.event === 'transactions/deleted'
      ) {
        await processTransactionEvent(options, stored, payload, stored.workspaceId, context);
      } else {
        await processItemEvent(options, stored, payload, stored.workspaceId, context);
      }
      await options.webhookPersistence.markProcessed(
        stored.workspaceId,
        stored.id,
        options.now?.() ?? new Date(),
      );
    } catch (error) {
      if (stored?.workspaceId !== null && stored?.workspaceId !== undefined) {
        try {
          await options.webhookPersistence.markFailed(
            stored.workspaceId,
            stored.id,
            'WEBHOOK_PROCESSING_FAILED',
          );
        } catch {
          // Preserve the processing failure; queue disposition remains the recovery authority.
        }
      }
      if (error instanceof QueueJobFailure) throw error;
      throw new QueueJobFailure({
        errorCode: 'WEBHOOK_PROCESSING_FAILED',
        redactedSummary: 'Webhook event processing failed.',
        retryable: retryableFailure(error),
      });
    }
  };
}
