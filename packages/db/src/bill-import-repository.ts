import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { parseDecimalString } from '@cashcount/domain';
import type { ProviderBillDto } from '@cashcount/provider-core';

import {
  canonicalJsonSha256,
  canonicalizeJson,
  type PayloadEncryptionService,
} from './encryption.js';
import {
  creditCardBill,
  creditCardBillFinanceCharge,
  creditCardBillPayment,
  financialAccount,
  financialTransaction,
  providerConnection,
  providerRawObject,
} from './schema.js';
import type * as schema from './schema.js';

export interface BillImportAccount {
  externalAccountId: string;
  financialAccountId: string;
}

export interface BillImportTarget {
  accounts: BillImportAccount[];
  localStatus: string;
}

export interface BillImportResult {
  billsInserted: number;
  billsSeen: number;
  billsUpdated: number;
  financeChargesInserted: number;
  financeChargesUpdated: number;
  paymentsInserted: number;
  paymentsUpdated: number;
  rawSnapshotsInserted: number;
  transactionsLinked: number;
}

export class BillImportInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BillImportInvariantError';
  }
}

function databaseDate(value: Date | null | string): null | string {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function databaseDecimal(value: null | string): null | string {
  return value === null ? null : parseDecimalString(value);
}

function equalComparable(left: object, right: object): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function nullableInstant(value: null | string): Date | null {
  return value === null ? null : new Date(value);
}

export class BillImportRepository {
  public constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  public async getImportTarget(
    workspaceId: string,
    providerConnectionId: string,
  ): Promise<BillImportTarget | null> {
    const connections = await this.database
      .select({ localStatus: providerConnection.localStatus })
      .from(providerConnection)
      .where(
        and(
          eq(providerConnection.workspaceId, workspaceId),
          eq(providerConnection.id, providerConnectionId),
          eq(providerConnection.provider, 'PLUGGY'),
        ),
      )
      .limit(1);
    const connection = connections[0];
    if (connection === undefined) return null;
    const accounts = await this.database
      .select({
        externalAccountId: financialAccount.externalAccountId,
        financialAccountId: financialAccount.id,
      })
      .from(financialAccount)
      .where(
        and(
          eq(financialAccount.workspaceId, workspaceId),
          eq(financialAccount.providerConnectionId, providerConnectionId),
          eq(financialAccount.provider, 'PLUGGY'),
          eq(financialAccount.accountType, 'CREDIT_CARD'),
          eq(financialAccount.isActive, true),
        ),
      );
    return { accounts, localStatus: connection.localStatus };
  }

  public async importBills(
    workspaceId: string,
    providerConnectionId: string,
    account: BillImportAccount,
    bills: readonly ProviderBillDto[],
    encryption: PayloadEncryptionService,
    observedAt = new Date(),
  ): Promise<BillImportResult> {
    if (bills.some((bill) => bill.externalAccountId !== account.externalAccountId)) {
      throw new BillImportInvariantError('Provider returned a bill for a different account.');
    }
    if (new Set(bills.map((bill) => bill.externalBillId)).size !== bills.length) {
      throw new BillImportInvariantError('Provider returned duplicate bill identities.');
    }
    for (const bill of bills) {
      if (
        new Set(bill.payments.map((payment) => payment.externalPaymentId)).size !==
        bill.payments.length
      ) {
        throw new BillImportInvariantError('Provider returned duplicate bill payment identities.');
      }
      if (
        new Set(bill.financeCharges.map((charge) => charge.externalChargeId)).size !==
        bill.financeCharges.length
      ) {
        throw new BillImportInvariantError(
          'Provider returned duplicate bill finance-charge identities.',
        );
      }
    }

    return this.database.transaction(async (transaction) => {
      const connections = await transaction
        .select({ localStatus: providerConnection.localStatus })
        .from(providerConnection)
        .where(
          and(
            eq(providerConnection.workspaceId, workspaceId),
            eq(providerConnection.id, providerConnectionId),
            eq(providerConnection.provider, 'PLUGGY'),
          ),
        )
        .limit(1)
        .for('update');
      const connection = connections[0];
      if (
        connection === undefined ||
        connection.localStatus === 'DELETED' ||
        connection.localStatus === 'DISABLED'
      ) {
        throw new BillImportInvariantError('Bill import target is unavailable.');
      }
      const accountRows = await transaction
        .select({ externalAccountId: financialAccount.externalAccountId })
        .from(financialAccount)
        .where(
          and(
            eq(financialAccount.workspaceId, workspaceId),
            eq(financialAccount.id, account.financialAccountId),
            eq(financialAccount.providerConnectionId, providerConnectionId),
            eq(financialAccount.provider, 'PLUGGY'),
            eq(financialAccount.accountType, 'CREDIT_CARD'),
            eq(financialAccount.isActive, true),
          ),
        )
        .limit(1)
        .for('update');
      if (accountRows[0]?.externalAccountId !== account.externalAccountId) {
        throw new BillImportInvariantError('Bill import account is unavailable.');
      }

      let billsInserted = 0;
      let billsUpdated = 0;
      let financeChargesInserted = 0;
      let financeChargesUpdated = 0;
      let paymentsInserted = 0;
      let paymentsUpdated = 0;
      let rawSnapshotsInserted = 0;
      let transactionsLinked = 0;

      const snapshot = async (input: {
        entityType: string;
        externalId: string;
        latestRawObjectId: null | string;
        providerUpdatedAt: Date | null;
        raw: unknown;
      }): Promise<{ id: string; inserted: boolean }> => {
        let latestPayloadHash: null | string = null;
        if (input.latestRawObjectId !== null) {
          const rows = await transaction
            .select({ payloadSha256: providerRawObject.payloadSha256 })
            .from(providerRawObject)
            .where(
              and(
                eq(providerRawObject.workspaceId, workspaceId),
                eq(providerRawObject.id, input.latestRawObjectId),
                eq(providerRawObject.provider, 'PLUGGY'),
                eq(providerRawObject.entityType, input.entityType),
                eq(providerRawObject.externalId, input.externalId),
              ),
            )
            .limit(1);
          latestPayloadHash = rows[0]?.payloadSha256 ?? null;
        }
        if (latestPayloadHash === canonicalJsonSha256(input.raw)) {
          if (input.latestRawObjectId === null) {
            throw new BillImportInvariantError('Bill raw snapshot resolution failed.');
          }
          return { id: input.latestRawObjectId, inserted: false };
        }
        const id = randomUUID();
        const envelope = encryption.encryptJson(input.raw, {
          entityType: input.entityType,
          externalId: input.externalId,
          provider: 'PLUGGY',
          recordId: id,
          storageTable: 'provider_raw_object',
          workspaceId,
        });
        await transaction.insert(providerRawObject).values({
          canonicalizationVersion: envelope.canonicalizationVersion,
          entityType: input.entityType,
          externalId: input.externalId,
          id,
          keyVersion: envelope.keyVersion,
          observedAt,
          payloadCiphertext: Buffer.from(envelope.ciphertext),
          payloadIv: Buffer.from(envelope.nonce),
          payloadSha256: envelope.payloadSha256,
          payloadTag: Buffer.from(envelope.authenticationTag),
          provider: 'PLUGGY',
          providerUpdatedAt: input.providerUpdatedAt,
          workspaceId,
        });
        rawSnapshotsInserted += 1;
        return { id, inserted: true };
      };

      for (const bill of bills) {
        const existingBillRows = await transaction
          .select({
            allowsInstallments: creditCardBill.allowsInstallments,
            closeDate: creditCardBill.closeDate,
            currency: creditCardBill.currency,
            dueDate: creditCardBill.dueDate,
            id: creditCardBill.id,
            latestRawObjectId: creditCardBill.latestRawObjectId,
            minimumPayment: creditCardBill.minimumPayment,
            providerStatus: creditCardBill.providerStatus,
            status: creditCardBill.status,
            totalAmount: creditCardBill.totalAmount,
          })
          .from(creditCardBill)
          .where(
            and(
              eq(creditCardBill.workspaceId, workspaceId),
              eq(creditCardBill.provider, 'PLUGGY'),
              eq(creditCardBill.externalBillId, bill.externalBillId),
            ),
          )
          .limit(1);
        const existingBill = existingBillRows[0];
        const billSnapshot = await snapshot({
          entityType: 'BILL',
          externalId: bill.externalBillId,
          latestRawObjectId: existingBill?.latestRawObjectId ?? null,
          providerUpdatedAt: nullableInstant(bill.providerUpdatedAt),
          raw: bill.raw,
        });
        const billComparable = {
          allowsInstallments: bill.allowsInstallments,
          closeDate: bill.closeDate,
          currency: bill.currency,
          dueDate: bill.dueDate,
          minimumPayment: bill.minimumPayment,
          providerStatus: bill.providerStatus,
          status: bill.status,
          totalAmount: bill.totalAmount,
        };
        let internalBillId: string;
        if (existingBill === undefined) {
          internalBillId = randomUUID();
          await transaction.insert(creditCardBill).values({
            ...billComparable,
            externalBillId: bill.externalBillId,
            financialAccountId: account.financialAccountId,
            id: internalBillId,
            latestRawObjectId: billSnapshot.id,
            provider: 'PLUGGY',
            workspaceId,
          });
          billsInserted += 1;
        } else {
          internalBillId = existingBill.id;
          const storedComparable = {
            allowsInstallments: existingBill.allowsInstallments,
            closeDate: databaseDate(existingBill.closeDate),
            currency: existingBill.currency,
            dueDate: databaseDate(existingBill.dueDate),
            minimumPayment: databaseDecimal(existingBill.minimumPayment),
            providerStatus: existingBill.providerStatus,
            status: existingBill.status,
            totalAmount: databaseDecimal(existingBill.totalAmount),
          };
          if (!equalComparable(storedComparable, billComparable) || billSnapshot.inserted) {
            await transaction
              .update(creditCardBill)
              .set({
                ...billComparable,
                financialAccountId: account.financialAccountId,
                latestRawObjectId: billSnapshot.id,
                updatedAt: observedAt,
              })
              .where(
                and(
                  eq(creditCardBill.workspaceId, workspaceId),
                  eq(creditCardBill.id, internalBillId),
                ),
              );
            billsUpdated += 1;
          }
        }

        const linked = await transaction
          .update(financialTransaction)
          .set({ creditCardBillId: internalBillId, updatedAt: observedAt })
          .where(
            and(
              eq(financialTransaction.workspaceId, workspaceId),
              eq(financialTransaction.financialAccountId, account.financialAccountId),
              eq(financialTransaction.provider, 'PLUGGY'),
              eq(financialTransaction.providerBillId, bill.externalBillId),
              isNull(financialTransaction.creditCardBillId),
            ),
          )
          .returning({ id: financialTransaction.id });
        transactionsLinked += linked.length;

        for (const payment of bill.payments) {
          const existingRows = await transaction
            .select({
              amount: creditCardBillPayment.amount,
              currency: creditCardBillPayment.currency,
              id: creditCardBillPayment.id,
              latestRawObjectId: creditCardBillPayment.latestRawObjectId,
              paymentDate: creditCardBillPayment.paymentDate,
              paymentMode: creditCardBillPayment.paymentMode,
              valueType: creditCardBillPayment.valueType,
            })
            .from(creditCardBillPayment)
            .where(
              and(
                eq(creditCardBillPayment.workspaceId, workspaceId),
                eq(creditCardBillPayment.creditCardBillId, internalBillId),
                eq(creditCardBillPayment.provider, 'PLUGGY'),
                eq(creditCardBillPayment.externalPaymentId, payment.externalPaymentId),
              ),
            )
            .limit(1);
          const existing = existingRows[0];
          const raw = await snapshot({
            entityType: 'BILL_PAYMENT',
            externalId: payment.externalPaymentId,
            latestRawObjectId: existing?.latestRawObjectId ?? null,
            providerUpdatedAt: null,
            raw: payment.raw,
          });
          const comparable = {
            amount: payment.amount,
            currency: payment.currency,
            paymentDate: payment.paymentDate,
            paymentMode: payment.paymentMode,
            valueType: payment.valueType,
          };
          if (existing === undefined) {
            await transaction.insert(creditCardBillPayment).values({
              ...comparable,
              creditCardBillId: internalBillId,
              externalPaymentId: payment.externalPaymentId,
              latestRawObjectId: raw.id,
              provider: 'PLUGGY',
              workspaceId,
            });
            paymentsInserted += 1;
          } else if (
            !equalComparable(
              {
                amount: parseDecimalString(existing.amount),
                currency: existing.currency,
                paymentDate: databaseDate(existing.paymentDate),
                paymentMode: existing.paymentMode,
                valueType: existing.valueType,
              },
              comparable,
            ) ||
            raw.inserted
          ) {
            await transaction
              .update(creditCardBillPayment)
              .set({ ...comparable, latestRawObjectId: raw.id, updatedAt: observedAt })
              .where(
                and(
                  eq(creditCardBillPayment.workspaceId, workspaceId),
                  eq(creditCardBillPayment.id, existing.id),
                ),
              );
            paymentsUpdated += 1;
          }
        }

        for (const charge of bill.financeCharges) {
          const existingRows = await transaction
            .select({
              additionalInfo: creditCardBillFinanceCharge.additionalInfo,
              amount: creditCardBillFinanceCharge.amount,
              chargeType: creditCardBillFinanceCharge.chargeType,
              currency: creditCardBillFinanceCharge.currency,
              id: creditCardBillFinanceCharge.id,
              latestRawObjectId: creditCardBillFinanceCharge.latestRawObjectId,
            })
            .from(creditCardBillFinanceCharge)
            .where(
              and(
                eq(creditCardBillFinanceCharge.workspaceId, workspaceId),
                eq(creditCardBillFinanceCharge.creditCardBillId, internalBillId),
                eq(creditCardBillFinanceCharge.provider, 'PLUGGY'),
                eq(creditCardBillFinanceCharge.externalChargeId, charge.externalChargeId),
              ),
            )
            .limit(1);
          const existing = existingRows[0];
          const raw = await snapshot({
            entityType: 'BILL_FINANCE_CHARGE',
            externalId: charge.externalChargeId,
            latestRawObjectId: existing?.latestRawObjectId ?? null,
            providerUpdatedAt: null,
            raw: charge.raw,
          });
          const comparable = {
            additionalInfo: charge.additionalInfo,
            amount: charge.amount,
            chargeType: charge.chargeType,
            currency: charge.currency,
          };
          if (existing === undefined) {
            await transaction.insert(creditCardBillFinanceCharge).values({
              ...comparable,
              creditCardBillId: internalBillId,
              externalChargeId: charge.externalChargeId,
              latestRawObjectId: raw.id,
              provider: 'PLUGGY',
              workspaceId,
            });
            financeChargesInserted += 1;
          } else if (
            !equalComparable(
              {
                additionalInfo: existing.additionalInfo,
                amount: parseDecimalString(existing.amount),
                chargeType: existing.chargeType,
                currency: existing.currency,
              },
              comparable,
            ) ||
            raw.inserted
          ) {
            await transaction
              .update(creditCardBillFinanceCharge)
              .set({ ...comparable, latestRawObjectId: raw.id, updatedAt: observedAt })
              .where(
                and(
                  eq(creditCardBillFinanceCharge.workspaceId, workspaceId),
                  eq(creditCardBillFinanceCharge.id, existing.id),
                ),
              );
            financeChargesUpdated += 1;
          }
        }
      }

      return {
        billsInserted,
        billsSeen: bills.length,
        billsUpdated,
        financeChargesInserted,
        financeChargesUpdated,
        paymentsInserted,
        paymentsUpdated,
        rawSnapshotsInserted,
        transactionsLinked,
      };
    });
  }
}
