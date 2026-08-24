import type { BillImportResult, BillImportTarget, PayloadEncryptionService } from '@cashcount/db';
import type { ProviderBillDto } from '@cashcount/provider-core';

export interface BillImportProvider {
  listCreditCardBills(externalAccountId: string): Promise<ProviderBillDto[]>;
}

export interface BillImportPersistence {
  getImportTarget(
    workspaceId: string,
    providerConnectionId: string,
  ): Promise<BillImportTarget | null>;
  importBills(
    workspaceId: string,
    providerConnectionId: string,
    account: BillImportTarget['accounts'][number],
    bills: readonly ProviderBillDto[],
    encryption: PayloadEncryptionService,
    observedAt?: Date,
  ): Promise<BillImportResult>;
}

export interface ImportBillsOptions {
  encryption: PayloadEncryptionService;
  now?: () => Date;
  persistence: BillImportPersistence;
  provider: BillImportProvider;
  providerConnectionId: string;
  workspaceId: string;
}

export class BillImportTargetUnavailableError extends Error {
  public constructor() {
    super('Bill import target is unavailable.');
    this.name = 'BillImportTargetUnavailableError';
  }
}

function emptyResult(): BillImportResult {
  return {
    billsInserted: 0,
    billsSeen: 0,
    billsUpdated: 0,
    financeChargesInserted: 0,
    financeChargesUpdated: 0,
    paymentsInserted: 0,
    paymentsUpdated: 0,
    rawSnapshotsInserted: 0,
    transactionsLinked: 0,
  };
}

function addResult(total: BillImportResult, addition: BillImportResult): BillImportResult {
  return {
    billsInserted: total.billsInserted + addition.billsInserted,
    billsSeen: total.billsSeen + addition.billsSeen,
    billsUpdated: total.billsUpdated + addition.billsUpdated,
    financeChargesInserted: total.financeChargesInserted + addition.financeChargesInserted,
    financeChargesUpdated: total.financeChargesUpdated + addition.financeChargesUpdated,
    paymentsInserted: total.paymentsInserted + addition.paymentsInserted,
    paymentsUpdated: total.paymentsUpdated + addition.paymentsUpdated,
    rawSnapshotsInserted: total.rawSnapshotsInserted + addition.rawSnapshotsInserted,
    transactionsLinked: total.transactionsLinked + addition.transactionsLinked,
  };
}

export async function importBills(options: ImportBillsOptions): Promise<BillImportResult> {
  const target = await options.persistence.getImportTarget(
    options.workspaceId,
    options.providerConnectionId,
  );
  if (target === null || target.localStatus === 'DELETED' || target.localStatus === 'DISABLED') {
    throw new BillImportTargetUnavailableError();
  }

  const observedAt = (options.now ?? (() => new Date()))();
  let result = emptyResult();
  for (const account of target.accounts) {
    const bills = await options.provider.listCreditCardBills(account.externalAccountId);
    result = addResult(
      result,
      await options.persistence.importBills(
        options.workspaceId,
        options.providerConnectionId,
        account,
        bills,
        options.encryption,
        observedAt,
      ),
    );
  }
  return result;
}
