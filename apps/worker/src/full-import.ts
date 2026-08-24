import type {
  AccountImportResult,
  BillImportResult,
  PayloadEncryptionService,
  TransactionSyncResult,
  TransactionSyncTrigger,
} from '@cashcount/db';

import {
  importAccounts,
  type AccountImportPersistence,
  type AccountImportProvider,
} from './account-import.js';
import { importBills, type BillImportPersistence, type BillImportProvider } from './bill-import.js';
import {
  importTransactions,
  type TransactionImportPersistence,
  type TransactionImportProvider,
} from './transaction-import.js';

const workspaceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface FullImportProvider
  extends AccountImportProvider, BillImportProvider, TransactionImportProvider {}

export interface FullImportResult {
  accounts: AccountImportResult;
  bills: BillImportResult;
  transactions: TransactionSyncResult;
}

export interface RunFullImportOptions {
  accountPersistence: AccountImportPersistence;
  billPersistence: BillImportPersistence;
  encryption: PayloadEncryptionService;
  now?: () => Date;
  provider: FullImportProvider;
  providerConnectionId: string;
  transactionPersistence: TransactionImportPersistence;
  triggerType?: TransactionSyncTrigger;
  workspaceId: string;
}

export interface FullImportArguments {
  providerConnectionId: string;
  workspaceId: string;
}

export class FullImportUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FullImportUsageError';
  }
}

export function parseFullImportArguments(arguments_: readonly string[]): FullImportArguments {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== '--workspace' ||
    arguments_[2] !== '--connection'
  ) {
    throw new FullImportUsageError(
      'Usage: pnpm sync:full --workspace <workspace-uuid> --connection <connection-uuid>',
    );
  }
  const workspaceId = arguments_[1] ?? '';
  const providerConnectionId = arguments_[3] ?? '';
  if (!workspaceIdPattern.test(workspaceId)) {
    throw new FullImportUsageError('The workspace must be a canonical UUID.');
  }
  if (!workspaceIdPattern.test(providerConnectionId)) {
    throw new FullImportUsageError('The connection must be a canonical UUID.');
  }
  return { providerConnectionId, workspaceId };
}

export async function runFullImport(options: RunFullImportOptions): Promise<FullImportResult> {
  const now = options.now ?? (() => new Date());
  const observedAt = now();
  const accounts = await importAccounts({
    encryption: options.encryption,
    observedAt,
    persistence: options.accountPersistence,
    provider: options.provider,
    providerConnectionId: options.providerConnectionId,
    workspaceId: options.workspaceId,
  });
  const transactions = await importTransactions({
    encryption: options.encryption,
    now,
    persistence: options.transactionPersistence,
    provider: options.provider,
    providerConnectionId: options.providerConnectionId,
    triggerType: options.triggerType ?? 'MANUAL',
    workspaceId: options.workspaceId,
  });
  const bills = await importBills({
    encryption: options.encryption,
    now,
    persistence: options.billPersistence,
    provider: options.provider,
    providerConnectionId: options.providerConnectionId,
    workspaceId: options.workspaceId,
  });
  return { accounts, bills, transactions };
}
