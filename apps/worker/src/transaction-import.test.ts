import {
  PayloadEncryptionService,
  type TransactionImportAccount,
  type TransactionPageImportResult,
  type TransactionSyncResult,
} from '@cashcount/db';
import { providerTransactionSchema, type ProviderTransactionDto } from '@cashcount/provider-core';
import { describe, expect, it, vi } from 'vitest';

import {
  TransactionCursorInvariantError,
  TransactionImportFailureRecordingError,
  importTransactions,
  type TransactionImportPersistence,
} from './transaction-import.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const providerConnectionId = '22222222-2222-4222-8222-222222222222';
const syncRunId = '33333333-3333-4333-8333-333333333333';
const account: TransactionImportAccount = {
  accountCurrency: 'BRL',
  accountType: 'CHECKING',
  externalAccountId: '44444444-4444-4444-8444-444444444444',
  financialAccountId: '55555555-5555-4555-8555-555555555555',
};
const pageResult: TransactionPageImportResult = {
  rawSnapshotsInserted: 1,
  transactionsDeleted: 0,
  transactionsInserted: 1,
  transactionsSeen: 1,
  transactionsUpdated: 0,
};
const syncResult: TransactionSyncResult = {
  accountsSeen: 1,
  syncRunId,
  transactionsDeleted: 0,
  transactionsInserted: 2,
  transactionsSeen: 2,
  transactionsUpdated: 0,
};

function transaction(id: string): ProviderTransactionDto {
  return providerTransactionSchema.parse({
    accountCurrency: 'BRL',
    amountInAccountCurrencySigned: null,
    amountSigned: '-12.340000',
    categoryId: null,
    categoryName: null,
    creditCardMetadata: null,
    currency: 'BRL',
    description: 'Synthetic purchase',
    descriptionRaw: null,
    externalAccountId: account.externalAccountId,
    externalTransactionId: id,
    merchant: null,
    operationType: null,
    operationTypeAdditionalInfo: null,
    providerCode: null,
    providerId: null,
    providerType: 'DEBIT',
    purchaseAt: null,
    raw: { id, privateMarker: 'must-remain-encrypted' },
    status: 'POSTED',
    transactionAt: '2026-08-23T12:00:00.000Z',
  });
}

function encryption(): PayloadEncryptionService {
  return new PayloadEncryptionService({
    activeKeyVersion: 1,
    keyring: new Map([[1, new Uint8Array(32).fill(33)]]),
  });
}

function persistence(): TransactionImportPersistence {
  return {
    completeAccount: vi.fn(async () => undefined),
    completeSync: vi.fn(async () => syncResult),
    failSync: vi.fn(async () => undefined),
    importPage: vi.fn(async () => pageResult),
    startSync: vi.fn(async () => ({ accounts: [account], syncRunId })),
  };
}

describe('transaction import orchestration', () => {
  it('exhausts every cursor before completing the account and sync run', async () => {
    const storage = persistence();
    const pages = [
      { items: [transaction('transaction-one')], nextCursor: 'cursor-two' },
      { items: [transaction('transaction-two')], nextCursor: null },
    ];
    const provider = {
      listTransactions: vi.fn(async () => {
        const page = pages.shift();
        if (page === undefined) throw new Error('Unexpected extra page request.');
        return page;
      }),
    };
    const observedAt = new Date('2026-08-23T13:00:00.000Z');

    await expect(
      importTransactions({
        encryption: encryption(),
        now: () => observedAt,
        persistence: storage,
        provider,
        providerConnectionId,
        triggerType: 'INITIAL',
        workspaceId,
      }),
    ).resolves.toEqual(syncResult);
    expect(provider.listTransactions).toHaveBeenNthCalledWith(1, {
      cursor: null,
      externalAccountId: account.externalAccountId,
    });
    expect(provider.listTransactions).toHaveBeenNthCalledWith(2, {
      cursor: 'cursor-two',
      externalAccountId: account.externalAccountId,
    });
    expect(storage.importPage).toHaveBeenCalledTimes(2);
    expect(storage.completeAccount).toHaveBeenCalledWith(
      workspaceId,
      syncRunId,
      account.financialAccountId,
      observedAt,
    );
    expect(storage.completeSync).toHaveBeenCalledWith(workspaceId, syncRunId, observedAt);
    expect(storage.failSync).not.toHaveBeenCalled();
  });

  it('fails a sync run when the provider returns a cursor cycle', async () => {
    const storage = persistence();
    const provider = {
      listTransactions: vi
        .fn()
        .mockResolvedValueOnce({ items: [transaction('transaction-one')], nextCursor: 'repeat' })
        .mockResolvedValueOnce({ items: [transaction('transaction-two')], nextCursor: 'repeat' }),
    };

    await expect(
      importTransactions({
        encryption: encryption(),
        persistence: storage,
        provider,
        providerConnectionId,
        triggerType: 'MANUAL',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(TransactionCursorInvariantError);
    expect(storage.importPage).toHaveBeenCalledTimes(1);
    expect(storage.completeAccount).not.toHaveBeenCalled();
    expect(storage.completeSync).not.toHaveBeenCalled();
    expect(storage.failSync).toHaveBeenCalledWith(workspaceId, syncRunId, expect.any(Date));
  });

  it('enforces a bounded page count and records failure', async () => {
    const storage = persistence();
    const provider = {
      listTransactions: vi.fn(async () => ({
        items: [transaction('transaction-one')],
        nextCursor: 'another-page',
      })),
    };

    await expect(
      importTransactions({
        encryption: encryption(),
        maxPagesPerAccount: 1,
        persistence: storage,
        provider,
        providerConnectionId,
        triggerType: 'RECOVERY',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(TransactionCursorInvariantError);
    expect(storage.failSync).toHaveBeenCalledOnce();
  });

  it('fails closed when failure state cannot be recorded', async () => {
    const storage = persistence();
    storage.failSync = vi.fn(async () => {
      throw new Error('synthetic database outage');
    });

    await expect(
      importTransactions({
        encryption: encryption(),
        persistence: storage,
        provider: {
          listTransactions: vi.fn(async () => {
            throw new Error('synthetic provider outage');
          }),
        },
        providerConnectionId,
        triggerType: 'SCHEDULED',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(TransactionImportFailureRecordingError);
  });
});
