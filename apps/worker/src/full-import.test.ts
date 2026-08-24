import { PayloadEncryptionService } from '@cashcount/db';
import { describe, expect, it, vi } from 'vitest';

import {
  FullImportUsageError,
  parseFullImportArguments,
  runFullImport,
  type FullImportProvider,
} from './full-import.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const providerConnectionId = '22222222-2222-4222-8222-222222222222';

describe('full import orchestration', () => {
  it('requires explicit canonical workspace and connection identifiers', () => {
    expect(
      parseFullImportArguments(['--workspace', workspaceId, '--connection', providerConnectionId]),
    ).toEqual({ providerConnectionId, workspaceId });
    expect(() => parseFullImportArguments([])).toThrow(FullImportUsageError);
    expect(() =>
      parseFullImportArguments([
        '--workspace',
        'not-a-workspace',
        '--connection',
        providerConnectionId,
      ]),
    ).toThrow(/workspace/u);
  });

  it('runs account, transaction, and bill imports in dependency order', async () => {
    const calls: string[] = [];
    const provider: FullImportProvider = {
      listAccounts: vi.fn(async () => []),
      listCreditCardBills: vi.fn(async () => []),
      listTransactions: vi.fn(async () => ({ items: [], nextCursor: null })),
    };
    const accounts = {
      getImportTarget: vi.fn(async () => ({
        externalConnectionId: 'item-1',
        localStatus: 'ACTIVE',
      })),
      importAccounts: vi.fn(async () => {
        calls.push('accounts');
        return {
          accountsInserted: 0,
          accountsSeen: 0,
          accountsUpdated: 0,
          rawSnapshotsInserted: 0,
        };
      }),
    };
    const transactions = {
      completeAccount: vi.fn(async () => undefined),
      completeSync: vi.fn(async (_workspaceId: string, syncRunId: string) => {
        calls.push('transactions-complete');
        return {
          accountsSeen: 0,
          syncRunId,
          transactionsDeleted: 0,
          transactionsInserted: 0,
          transactionsSeen: 0,
          transactionsUpdated: 0,
        };
      }),
      failSync: vi.fn(async () => undefined),
      importPage: vi.fn(),
      startSync: vi.fn(async () => {
        calls.push('transactions-start');
        return { accounts: [], syncRunId: '33333333-3333-4333-8333-333333333333' };
      }),
    };
    const bills = {
      getImportTarget: vi.fn(async () => {
        calls.push('bills');
        return { accounts: [], localStatus: 'ACTIVE' };
      }),
      importBills: vi.fn(),
    };

    await expect(
      runFullImport({
        accountPersistence: accounts,
        billPersistence: bills,
        encryption: new PayloadEncryptionService({
          activeKeyVersion: 1,
          keyring: new Map([[1, new Uint8Array(32).fill(35)]]),
        }),
        now: () => new Date('2026-08-23T21:00:00.000Z'),
        provider,
        providerConnectionId,
        transactionPersistence: transactions,
        workspaceId,
      }),
    ).resolves.toMatchObject({
      accounts: { accountsSeen: 0 },
      bills: { billsSeen: 0 },
      transactions: { transactionsSeen: 0 },
    });
    expect(calls).toEqual(['accounts', 'transactions-start', 'transactions-complete', 'bills']);
  });
});
