import type {
  PayloadEncryptionService,
  TransactionImportAccount,
  TransactionPageImportResult,
  TransactionSyncResult,
  TransactionSyncStart,
  TransactionSyncTrigger,
} from '@cashcount/db';
import type { CursorPage, ProviderTransactionDto } from '@cashcount/provider-core';

export interface TransactionImportProvider {
  listTransactions(input: {
    cursor: null | string;
    externalAccountId: string;
  }): Promise<CursorPage<ProviderTransactionDto>>;
}

export interface TransactionImportPersistence {
  completeAccount(
    workspaceId: string,
    syncRunId: string,
    financialAccountId: string,
    completedAt?: Date,
  ): Promise<void>;
  completeSync(
    workspaceId: string,
    syncRunId: string,
    completedAt?: Date,
  ): Promise<TransactionSyncResult>;
  failSync(workspaceId: string, syncRunId: string, failedAt?: Date): Promise<void>;
  importPage(
    workspaceId: string,
    syncRunId: string,
    account: TransactionImportAccount,
    transactions: readonly ProviderTransactionDto[],
    nextCursor: null | string,
    encryption: PayloadEncryptionService,
    observedAt?: Date,
  ): Promise<TransactionPageImportResult>;
  startSync(
    workspaceId: string,
    providerConnectionId: string,
    triggerType: TransactionSyncTrigger,
    startedAt?: Date,
  ): Promise<TransactionSyncStart>;
}

export interface ImportTransactionsOptions {
  encryption: PayloadEncryptionService;
  maxPagesPerAccount?: number;
  now?: () => Date;
  persistence: TransactionImportPersistence;
  provider: TransactionImportProvider;
  providerConnectionId: string;
  replacementDetector?: TransactionReplacementDetector;
  triggerType: TransactionSyncTrigger;
  workspaceId: string;
}

export interface TransactionReplacementDetector {
  detectForSync(workspaceId: string, syncRunId: string, detectedAt?: Date): Promise<unknown>;
}

export class TransactionCursorInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TransactionCursorInvariantError';
  }
}

export class TransactionImportFailureRecordingError extends Error {
  public constructor() {
    super('Transaction import failed and its sync run could not be finalized.');
    this.name = 'TransactionImportFailureRecordingError';
  }
}

export async function importTransactions(
  options: ImportTransactionsOptions,
): Promise<TransactionSyncResult> {
  const now = options.now ?? (() => new Date());
  const maxPagesPerAccount = options.maxPagesPerAccount ?? 10_000;
  if (!Number.isSafeInteger(maxPagesPerAccount) || maxPagesPerAccount <= 0) {
    throw new RangeError('Transaction page limit must be a positive safe integer.');
  }
  const started = await options.persistence.startSync(
    options.workspaceId,
    options.providerConnectionId,
    options.triggerType,
    now(),
  );
  let completed: TransactionSyncResult;

  try {
    for (const account of started.accounts) {
      let cursor: null | string = null;
      const requestedCursors = new Set<string>();
      for (let pageNumber = 1; ; pageNumber += 1) {
        if (pageNumber > maxPagesPerAccount) {
          throw new TransactionCursorInvariantError('Transaction pagination exceeded its limit.');
        }
        if (cursor !== null) {
          if (requestedCursors.has(cursor)) {
            throw new TransactionCursorInvariantError('Transaction pagination repeated a cursor.');
          }
          requestedCursors.add(cursor);
        }
        const page = await options.provider.listTransactions({
          cursor,
          externalAccountId: account.externalAccountId,
        });
        if (page.nextCursor !== null && requestedCursors.has(page.nextCursor)) {
          throw new TransactionCursorInvariantError('Transaction pagination returned a cycle.');
        }
        await options.persistence.importPage(
          options.workspaceId,
          started.syncRunId,
          account,
          page.items,
          page.nextCursor,
          options.encryption,
          now(),
        );
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      await options.persistence.completeAccount(
        options.workspaceId,
        started.syncRunId,
        account.financialAccountId,
        now(),
      );
    }
    completed = await options.persistence.completeSync(
      options.workspaceId,
      started.syncRunId,
      now(),
    );
  } catch (error) {
    try {
      await options.persistence.failSync(options.workspaceId, started.syncRunId, now());
    } catch {
      throw new TransactionImportFailureRecordingError();
    }
    throw error;
  }
  await options.replacementDetector?.detectForSync(options.workspaceId, started.syncRunId, now());
  return completed;
}
