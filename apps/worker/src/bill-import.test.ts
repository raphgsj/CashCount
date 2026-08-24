import { PayloadEncryptionService, type BillImportResult } from '@cashcount/db';
import { providerBillSchema, type ProviderBillDto } from '@cashcount/provider-core';
import { describe, expect, it, vi } from 'vitest';

import {
  BillImportTargetUnavailableError,
  importBills,
  type BillImportPersistence,
} from './bill-import.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const providerConnectionId = '22222222-2222-4222-8222-222222222222';
const account = {
  externalAccountId: '33333333-3333-4333-8333-333333333333',
  financialAccountId: '44444444-4444-4444-8444-444444444444',
};
const result: BillImportResult = {
  billsInserted: 1,
  billsSeen: 1,
  billsUpdated: 0,
  financeChargesInserted: 1,
  financeChargesUpdated: 0,
  paymentsInserted: 1,
  paymentsUpdated: 0,
  rawSnapshotsInserted: 3,
  transactionsLinked: 1,
};

function bill(): ProviderBillDto {
  return providerBillSchema.parse({
    allowsInstallments: null,
    closeDate: null,
    currency: 'BRL',
    dueDate: '2026-09-10',
    externalAccountId: account.externalAccountId,
    externalBillId: '55555555-5555-4555-8555-555555555555',
    financeCharges: [
      {
        additionalInfo: null,
        amount: '1.230000',
        chargeType: 'IOF',
        currency: 'BRL',
        externalChargeId: '77777777-7777-4777-8777-777777777777',
        raw: { privateChargeMarker: 'encrypted-only' },
      },
    ],
    minimumPayment: null,
    payments: [
      {
        amount: '100.000000',
        currency: 'BRL',
        externalPaymentId: '66666666-6666-4666-8666-666666666666',
        paymentDate: '2026-08-20',
        paymentMode: null,
        raw: { privatePaymentMarker: 'encrypted-only' },
        valueType: 'FULL_PAYMENT',
      },
    ],
    providerStatus: null,
    providerUpdatedAt: null,
    raw: { privateBillMarker: 'encrypted-only' },
    status: 'UNKNOWN',
    totalAmount: '250.000000',
  });
}

function encryption(): PayloadEncryptionService {
  return new PayloadEncryptionService({
    activeKeyVersion: 1,
    keyring: new Map([[1, new Uint8Array(32).fill(34)]]),
  });
}

function persistence(localStatus = 'ACTIVE'): BillImportPersistence {
  return {
    getImportTarget: vi.fn(async () => ({ accounts: [account], localStatus })),
    importBills: vi.fn(async () => result),
  };
}

describe('bill import orchestration', () => {
  it('does not access the provider without an available workspace-scoped target', async () => {
    const storage = persistence();
    storage.getImportTarget = vi.fn(async () => null);
    const provider = { listCreditCardBills: vi.fn(async () => [bill()]) };

    await expect(
      importBills({
        encryption: encryption(),
        persistence: storage,
        provider,
        providerConnectionId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(BillImportTargetUnavailableError);
    expect(provider.listCreditCardBills).not.toHaveBeenCalled();
  });

  it.each(['DELETED', 'DISABLED'])('does not import a %s connection', async (localStatus) => {
    const provider = { listCreditCardBills: vi.fn(async () => [bill()]) };

    await expect(
      importBills({
        encryption: encryption(),
        persistence: persistence(localStatus),
        provider,
        providerConnectionId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(BillImportTargetUnavailableError);
    expect(provider.listCreditCardBills).not.toHaveBeenCalled();
  });

  it('imports each credit-card account and aggregates non-sensitive counts', async () => {
    const storage = persistence();
    const provider = { listCreditCardBills: vi.fn(async () => [bill()]) };
    const observedAt = new Date('2026-08-23T18:00:00.000Z');
    const payloadEncryption = encryption();

    await expect(
      importBills({
        encryption: payloadEncryption,
        now: () => observedAt,
        persistence: storage,
        provider,
        providerConnectionId,
        workspaceId,
      }),
    ).resolves.toEqual(result);
    expect(provider.listCreditCardBills).toHaveBeenCalledWith(account.externalAccountId);
    expect(storage.importBills).toHaveBeenCalledWith(
      workspaceId,
      providerConnectionId,
      account,
      expect.any(Array),
      payloadEncryption,
      observedAt,
    );
  });
});
