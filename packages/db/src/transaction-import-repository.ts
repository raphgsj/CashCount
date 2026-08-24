import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { normalizeTransactionDescription } from '@cashcount/classification';
import {
  accountTypes,
  billForecastMonthToBankDate,
  classifyTransaction,
  deriveFinancialDate,
  parseDecimalString,
  type AccountType,
} from '@cashcount/domain';
import type { ProviderTransactionDto } from '@cashcount/provider-core';

import {
  canonicalJsonSha256,
  canonicalizeJson,
  type PayloadEncryptionService,
} from './encryption.js';
import {
  creditCardBill,
  financialAccount,
  financialTransaction,
  providerConnection,
  providerRawObject,
  syncRun,
  transactionRevision,
  workspace,
} from './schema.js';
import type * as schema from './schema.js';

export type TransactionSyncTrigger = 'INITIAL' | 'MANUAL' | 'RECOVERY' | 'SCHEDULED' | 'WEBHOOK';

export interface TransactionImportAccount {
  accountCurrency: string;
  accountType: AccountType;
  externalAccountId: string;
  financialAccountId: string;
}

export interface TransactionSyncStart {
  accounts: TransactionImportAccount[];
  syncRunId: string;
}

export interface TransactionPageImportResult {
  rawSnapshotsInserted: number;
  transactionsDeleted: number;
  transactionsInserted: number;
  transactionsSeen: number;
  transactionsUpdated: number;
}

export interface TransactionSyncResult {
  accountsSeen: number;
  syncRunId: string;
  transactionsDeleted: number;
  transactionsInserted: number;
  transactionsSeen: number;
  transactionsUpdated: number;
}

export class TransactionImportInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TransactionImportInvariantError';
  }
}

function isAccountType(value: string): value is AccountType {
  return accountTypes.includes(value as AccountType);
}

function fingerprint(input: {
  accountId: string;
  amountSigned: string;
  currency: string;
  descriptionNormalized: string;
  installmentNumber: null | number;
  installmentTotal: null | number;
  localDate: string;
  workspaceId: string;
}): string {
  return createHash('sha256').update(canonicalizeJson(input), 'utf8').digest('hex');
}

function summarizedRevisionValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 100) {
    return {
      length: value.length,
      sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
    };
  }
  return value;
}

function changedFields(existing: object, incoming: object): Record<string, unknown> | null {
  const existingRecord = existing as Record<string, unknown>;
  const incomingRecord = incoming as Record<string, unknown>;
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  for (const field of Object.keys(incomingRecord).sort()) {
    const from = summarizedRevisionValue(existingRecord[field]);
    const to = summarizedRevisionValue(incomingRecord[field]);
    if (canonicalizeJson(from) !== canonicalizeJson(to)) changes.push({ field, from, to });
  }
  return changes.length === 0 ? null : { changes };
}

function earliest(current: null | string, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function latest(current: null | string, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

function nullableInstant(value: null | string): Date | null {
  return value === null ? null : new Date(value);
}

function databaseDate(value: Date | null | string): null | string {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function databaseDecimal(value: null | string): null | string {
  return value === null ? null : parseDecimalString(value);
}

export class TransactionImportRepository {
  public constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  public async startSync(
    workspaceId: string,
    providerConnectionId: string,
    triggerType: TransactionSyncTrigger,
    startedAt = new Date(),
  ): Promise<TransactionSyncStart> {
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
        throw new TransactionImportInvariantError('Transaction sync target is unavailable.');
      }

      const accountRows = await transaction
        .select({
          accountCurrency: financialAccount.currency,
          accountType: financialAccount.accountType,
          externalAccountId: financialAccount.externalAccountId,
          financialAccountId: financialAccount.id,
        })
        .from(financialAccount)
        .where(
          and(
            eq(financialAccount.workspaceId, workspaceId),
            eq(financialAccount.providerConnectionId, providerConnectionId),
            eq(financialAccount.provider, 'PLUGGY'),
            eq(financialAccount.isActive, true),
          ),
        );
      const accounts = accountRows.map((account) => {
        if (!isAccountType(account.accountType)) {
          throw new TransactionImportInvariantError('Stored account type is unsupported.');
        }
        return { ...account, accountType: account.accountType };
      });
      const syncRunId = randomUUID();
      await transaction.insert(syncRun).values({
        accountsSeen: accounts.length,
        id: syncRunId,
        providerConnectionId,
        startedAt,
        triggerType,
        workspaceId,
      });
      await transaction
        .update(providerConnection)
        .set({ lastAttemptAt: startedAt, updatedAt: startedAt })
        .where(
          and(
            eq(providerConnection.workspaceId, workspaceId),
            eq(providerConnection.id, providerConnectionId),
          ),
        );
      return { accounts, syncRunId };
    });
  }

  public async startWebhookSync(
    workspaceId: string,
    providerConnectionId: string,
    externalAccountId: string,
    startedAt = new Date(),
  ): Promise<TransactionSyncStart> {
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
        throw new TransactionImportInvariantError('Transaction sync target is unavailable.');
      }
      const rows = await transaction
        .select({
          accountCurrency: financialAccount.currency,
          accountType: financialAccount.accountType,
          externalAccountId: financialAccount.externalAccountId,
          financialAccountId: financialAccount.id,
        })
        .from(financialAccount)
        .where(
          and(
            eq(financialAccount.workspaceId, workspaceId),
            eq(financialAccount.providerConnectionId, providerConnectionId),
            eq(financialAccount.provider, 'PLUGGY'),
            eq(financialAccount.externalAccountId, externalAccountId),
            eq(financialAccount.isActive, true),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined || !isAccountType(row.accountType)) {
        throw new TransactionImportInvariantError('Webhook transaction account is unavailable.');
      }
      const account: TransactionImportAccount = { ...row, accountType: row.accountType };
      const syncRunId = randomUUID();
      await transaction.insert(syncRun).values({
        accountsSeen: 1,
        id: syncRunId,
        providerConnectionId,
        startedAt,
        triggerType: 'WEBHOOK',
        workspaceId,
      });
      await transaction
        .update(providerConnection)
        .set({ lastAttemptAt: startedAt, updatedAt: startedAt })
        .where(
          and(
            eq(providerConnection.workspaceId, workspaceId),
            eq(providerConnection.id, providerConnectionId),
          ),
        );
      return { accounts: [account], syncRunId };
    });
  }

  public async deleteWebhookTransactions(
    workspaceId: string,
    syncRunId: string,
    account: TransactionImportAccount,
    externalTransactionIds: readonly string[],
    deletedAt = new Date(),
  ): Promise<number> {
    if (externalTransactionIds.length === 0 || externalTransactionIds.length > 1_000) {
      throw new TransactionImportInvariantError(
        'Webhook deletion must contain 1 to 1000 transaction identifiers.',
      );
    }
    if (new Set(externalTransactionIds).size !== externalTransactionIds.length) {
      throw new TransactionImportInvariantError(
        'Webhook deletion contains duplicate transaction identifiers.',
      );
    }

    return this.database.transaction(async (transaction) => {
      const runs = await transaction
        .select({ providerConnectionId: syncRun.providerConnectionId })
        .from(syncRun)
        .where(
          and(
            eq(syncRun.workspaceId, workspaceId),
            eq(syncRun.id, syncRunId),
            eq(syncRun.status, 'RUNNING'),
          ),
        )
        .limit(1)
        .for('update');
      const run = runs[0];
      if (run === undefined) {
        throw new TransactionImportInvariantError('Transaction sync run is unavailable.');
      }
      const accountRows = await transaction
        .select({ externalAccountId: financialAccount.externalAccountId })
        .from(financialAccount)
        .where(
          and(
            eq(financialAccount.workspaceId, workspaceId),
            eq(financialAccount.id, account.financialAccountId),
            eq(financialAccount.providerConnectionId, run.providerConnectionId),
            eq(financialAccount.provider, 'PLUGGY'),
          ),
        )
        .limit(1)
        .for('update');
      if (accountRows[0]?.externalAccountId !== account.externalAccountId) {
        throw new TransactionImportInvariantError('Transaction import account is unavailable.');
      }

      const existing = await transaction
        .select({
          deletedAt: financialTransaction.deletedAt,
          id: financialTransaction.id,
          providerTransactionId: financialTransaction.providerTransactionId,
          status: financialTransaction.status,
        })
        .from(financialTransaction)
        .where(
          and(
            eq(financialTransaction.workspaceId, workspaceId),
            eq(financialTransaction.financialAccountId, account.financialAccountId),
            eq(financialTransaction.provider, 'PLUGGY'),
            inArray(financialTransaction.providerTransactionId, [...externalTransactionIds]),
          ),
        )
        .for('update');
      let deleted = 0;
      for (const item of existing) {
        if (item.status === 'DELETED') continue;
        await transaction
          .update(financialTransaction)
          .set({ deletedAt, status: 'DELETED', updatedAt: deletedAt })
          .where(
            and(
              eq(financialTransaction.workspaceId, workspaceId),
              eq(financialTransaction.id, item.id),
            ),
          );
        await transaction.insert(transactionRevision).values({
          actorType: 'WORKER',
          changeType: 'DELETE',
          changedFields: {
            changes: [
              {
                field: 'deletedAt',
                from: item.deletedAt?.toISOString() ?? null,
                to: deletedAt.toISOString(),
              },
              { field: 'status', from: item.status, to: 'DELETED' },
            ],
          },
          createdAt: deletedAt,
          financialTransactionId: item.id,
          workspaceId,
        });
        deleted += 1;
      }
      await transaction
        .update(syncRun)
        .set({
          transactionsDeleted: sql`${syncRun.transactionsDeleted} + ${deleted}`,
          transactionsSeen: sql`${syncRun.transactionsSeen} + ${externalTransactionIds.length}`,
        })
        .where(
          and(
            eq(syncRun.workspaceId, workspaceId),
            eq(syncRun.id, syncRunId),
            eq(syncRun.status, 'RUNNING'),
          ),
        );
      return deleted;
    });
  }

  public async importPage(
    workspaceId: string,
    syncRunId: string,
    account: TransactionImportAccount,
    transactions: readonly ProviderTransactionDto[],
    nextCursor: null | string,
    encryption: PayloadEncryptionService,
    observedAt = new Date(),
  ): Promise<TransactionPageImportResult> {
    if (transactions.some((item) => item.externalAccountId !== account.externalAccountId)) {
      throw new TransactionImportInvariantError(
        'Provider returned a transaction for a different account.',
      );
    }
    if (transactions.some((item) => item.accountCurrency !== account.accountCurrency)) {
      throw new TransactionImportInvariantError(
        'Provider transaction account currency does not match the stored account.',
      );
    }
    if (transactions.some((item) => item.externalTransactionId === null)) {
      throw new TransactionImportInvariantError(
        'Pluggy transaction import requires a stable provider transaction identity.',
      );
    }
    const providerIds = transactions.map((item) => item.externalTransactionId as string);
    if (new Set(providerIds).size !== providerIds.length) {
      throw new TransactionImportInvariantError(
        'Provider returned duplicate transaction identities.',
      );
    }

    return this.database.transaction(async (transaction) => {
      const runs = await transaction
        .select({ providerConnectionId: syncRun.providerConnectionId })
        .from(syncRun)
        .where(
          and(
            eq(syncRun.workspaceId, workspaceId),
            eq(syncRun.id, syncRunId),
            eq(syncRun.status, 'RUNNING'),
          ),
        )
        .limit(1)
        .for('update');
      const run = runs[0];
      if (run === undefined) {
        throw new TransactionImportInvariantError('Transaction sync run is unavailable.');
      }

      const accountRows = await transaction
        .select({
          accountCurrency: financialAccount.currency,
          accountType: financialAccount.accountType,
          externalAccountId: financialAccount.externalAccountId,
        })
        .from(financialAccount)
        .where(
          and(
            eq(financialAccount.workspaceId, workspaceId),
            eq(financialAccount.id, account.financialAccountId),
            eq(financialAccount.providerConnectionId, run.providerConnectionId),
            eq(financialAccount.provider, 'PLUGGY'),
          ),
        )
        .limit(1)
        .for('update');
      const storedAccount = accountRows[0];
      if (
        storedAccount === undefined ||
        storedAccount.externalAccountId !== account.externalAccountId ||
        storedAccount.accountCurrency !== account.accountCurrency ||
        storedAccount.accountType !== account.accountType
      ) {
        throw new TransactionImportInvariantError('Transaction import account is unavailable.');
      }
      if (!isAccountType(storedAccount.accountType)) {
        throw new TransactionImportInvariantError('Stored account type is unsupported.');
      }
      const timezones = await transaction
        .select({ timezone: workspace.timezone })
        .from(workspace)
        .where(eq(workspace.id, workspaceId))
        .limit(1);
      const timezone = timezones[0]?.timezone;
      if (timezone === undefined) {
        throw new TransactionImportInvariantError('Transaction workspace is unavailable.');
      }

      let earliestDate: null | string = null;
      let latestDate: null | string = null;
      let rawSnapshotsInserted = 0;
      let transactionsDeleted = 0;
      let transactionsInserted = 0;
      let transactionsUpdated = 0;

      for (const item of transactions) {
        const providerTransactionId = item.externalTransactionId as string;
        const card = item.creditCardMetadata;
        const transactionLocalDate = deriveFinancialDate(item.transactionAt, timezone);
        const purchaseLocalDate =
          item.purchaseAt === null ? null : deriveFinancialDate(item.purchaseAt, timezone);
        const descriptionNormalized =
          normalizeTransactionDescription(item.description).normalized || 'unprintable';
        const transactionFingerprint = fingerprint({
          accountId: account.financialAccountId,
          amountSigned: item.amountSigned,
          currency: item.currency,
          descriptionNormalized,
          installmentNumber: card?.installmentNumber ?? null,
          installmentTotal: card?.totalInstallments ?? null,
          localDate: transactionLocalDate,
          workspaceId,
        });
        const classification = classifyTransaction({
          accountType: storedAccount.accountType,
          financeChargeTransaction: card?.feeType !== null && card?.feeType !== undefined,
          providerAmountSigned: item.amountSigned,
          providerType: item.providerType,
        });
        const existingRows = await transaction
          .select({
            accountCurrency: financialTransaction.accountCurrency,
            accountCurrencyAmountSigned: financialTransaction.accountCurrencyAmountSigned,
            billForecastMonth: financialTransaction.billForecastMonth,
            cardLastFour: financialTransaction.cardLastFour,
            creditCardBillId: financialTransaction.creditCardBillId,
            dedupeFingerprint: financialTransaction.dedupeFingerprint,
            deletedAt: financialTransaction.deletedAt,
            descriptionNormalized: financialTransaction.descriptionNormalized,
            descriptionOriginal: financialTransaction.descriptionOriginal,
            descriptionRaw: financialTransaction.descriptionRaw,
            feeType: financialTransaction.feeType,
            feeTypeAdditionalInfo: financialTransaction.feeTypeAdditionalInfo,
            id: financialTransaction.id,
            installmentNumber: financialTransaction.installmentNumber,
            installmentTotal: financialTransaction.installmentTotal,
            installmentTotalAmount: financialTransaction.installmentTotalAmount,
            latestRawObjectId: financialTransaction.latestRawObjectId,
            otherCreditsAdditionalInfo: financialTransaction.otherCreditsAdditionalInfo,
            otherCreditsType: financialTransaction.otherCreditsType,
            payeeMcc: financialTransaction.payeeMcc,
            providerAmountSigned: financialTransaction.providerAmountSigned,
            providerBillId: financialTransaction.providerBillId,
            providerCategoryId: financialTransaction.providerCategoryId,
            providerCategoryName: financialTransaction.providerCategoryName,
            providerCode: financialTransaction.providerCode,
            providerCurrency: financialTransaction.providerCurrency,
            providerId: financialTransaction.providerId,
            providerOperationType: financialTransaction.providerOperationType,
            providerOperationTypeAdditionalInfo:
              financialTransaction.providerOperationTypeAdditionalInfo,
            providerPurchaseAt: financialTransaction.providerPurchaseAt,
            providerTransactionAt: financialTransaction.providerTransactionAt,
            providerType: financialTransaction.providerType,
            purchaseLocalDate: financialTransaction.purchaseLocalDate,
            status: financialTransaction.status,
            systemDirection: financialTransaction.systemDirection,
            systemFinancialRole: financialTransaction.systemFinancialRole,
            systemFinancialRoleSource: financialTransaction.systemFinancialRoleSource,
            transactionLocalDate: financialTransaction.transactionLocalDate,
          })
          .from(financialTransaction)
          .where(
            and(
              eq(financialTransaction.workspaceId, workspaceId),
              eq(financialTransaction.provider, 'PLUGGY'),
              eq(financialTransaction.providerTransactionId, providerTransactionId),
            ),
          )
          .limit(1);
        const existing = existingRows[0];

        let latestRawObjectId = existing?.latestRawObjectId ?? null;
        let latestPayloadHash: null | string = null;
        if (latestRawObjectId !== null) {
          const rawRows = await transaction
            .select({ payloadSha256: providerRawObject.payloadSha256 })
            .from(providerRawObject)
            .where(
              and(
                eq(providerRawObject.workspaceId, workspaceId),
                eq(providerRawObject.id, latestRawObjectId),
                eq(providerRawObject.provider, 'PLUGGY'),
                eq(providerRawObject.entityType, 'TRANSACTION'),
                eq(providerRawObject.externalId, providerTransactionId),
              ),
            )
            .limit(1);
          latestPayloadHash = rawRows[0]?.payloadSha256 ?? null;
        }
        const payloadHash = canonicalJsonSha256(item.raw);
        let rawSnapshotInserted = false;
        if (latestPayloadHash !== payloadHash) {
          latestRawObjectId = randomUUID();
          const envelope = encryption.encryptJson(item.raw, {
            entityType: 'TRANSACTION',
            externalId: providerTransactionId,
            provider: 'PLUGGY',
            recordId: latestRawObjectId,
            storageTable: 'provider_raw_object',
            workspaceId,
          });
          await transaction.insert(providerRawObject).values({
            canonicalizationVersion: envelope.canonicalizationVersion,
            entityType: 'TRANSACTION',
            externalId: providerTransactionId,
            id: latestRawObjectId,
            keyVersion: envelope.keyVersion,
            observedAt,
            payloadCiphertext: Buffer.from(envelope.ciphertext),
            payloadIv: Buffer.from(envelope.nonce),
            payloadSha256: envelope.payloadSha256,
            payloadTag: Buffer.from(envelope.authenticationTag),
            provider: 'PLUGGY',
            workspaceId,
          });
          rawSnapshotInserted = true;
          rawSnapshotsInserted += 1;
        }
        if (latestRawObjectId === null) {
          throw new TransactionImportInvariantError('Transaction raw snapshot resolution failed.');
        }

        let creditCardBillId: null | string = null;
        if (card?.billId !== null && card?.billId !== undefined) {
          const billRows = await transaction
            .select({ id: creditCardBill.id })
            .from(creditCardBill)
            .where(
              and(
                eq(creditCardBill.workspaceId, workspaceId),
                eq(creditCardBill.financialAccountId, account.financialAccountId),
                eq(creditCardBill.provider, 'PLUGGY'),
                eq(creditCardBill.externalBillId, card.billId),
              ),
            )
            .limit(1);
          creditCardBillId = billRows[0]?.id ?? null;
        }

        const incomingComparable = {
          accountCurrency: item.accountCurrency,
          accountCurrencyAmountSigned: item.amountInAccountCurrencySigned,
          billForecastMonth:
            card?.billForecastMonth === null || card?.billForecastMonth === undefined
              ? null
              : billForecastMonthToBankDate(card.billForecastMonth),
          cardLastFour: card?.cardLastFour ?? null,
          creditCardBillId,
          dedupeFingerprint: transactionFingerprint,
          deletedAt: item.status === 'DELETED' ? (existing?.deletedAt ?? observedAt) : null,
          descriptionNormalized,
          descriptionOriginal: item.description,
          descriptionRaw: item.descriptionRaw,
          feeType: card?.feeType ?? null,
          feeTypeAdditionalInfo: card?.feeTypeAdditionalInfo ?? null,
          installmentNumber: card?.installmentNumber ?? null,
          installmentTotal: card?.totalInstallments ?? null,
          installmentTotalAmount: card?.totalAmount ?? null,
          otherCreditsAdditionalInfo: card?.otherCreditAdditionalInfo ?? null,
          otherCreditsType: card?.otherCreditType ?? null,
          payeeMcc: card?.mcc ?? null,
          providerAmountSigned: item.amountSigned,
          providerBillId: card?.billId ?? null,
          providerCategoryId: item.categoryId,
          providerCategoryName: item.categoryName,
          providerCode: item.providerCode,
          providerCurrency: item.currency,
          providerId: item.providerId,
          providerOperationType: item.operationType,
          providerOperationTypeAdditionalInfo: item.operationTypeAdditionalInfo,
          providerPurchaseAt: nullableInstant(item.purchaseAt),
          providerTransactionAt: new Date(item.transactionAt),
          providerType: item.providerType,
          purchaseLocalDate,
          status: item.status,
          systemDirection: classification.direction,
          systemFinancialRole: classification.role,
          transactionLocalDate,
        };

        if (existing === undefined) {
          const collisionRows = await transaction
            .select({ id: financialTransaction.id })
            .from(financialTransaction)
            .where(
              and(
                eq(financialTransaction.workspaceId, workspaceId),
                eq(financialTransaction.financialAccountId, account.financialAccountId),
                eq(financialTransaction.dedupeFingerprint, transactionFingerprint),
              ),
            )
            .limit(1);
          const duplicateReviewStatus = collisionRows.length === 0 ? 'NONE' : 'POSSIBLE';
          if (collisionRows.length > 0) {
            await transaction
              .update(financialTransaction)
              .set({ duplicateReviewStatus: 'POSSIBLE', updatedAt: observedAt })
              .where(
                and(
                  eq(financialTransaction.workspaceId, workspaceId),
                  eq(financialTransaction.financialAccountId, account.financialAccountId),
                  eq(financialTransaction.dedupeFingerprint, transactionFingerprint),
                  eq(financialTransaction.duplicateReviewStatus, 'NONE'),
                ),
              );
          }
          await transaction.insert(financialTransaction).values({
            ...incomingComparable,
            createdAt: observedAt,
            duplicateReviewStatus,
            financialAccountId: account.financialAccountId,
            latestRawObjectId,
            provider: 'PLUGGY',
            providerTransactionId,
            systemFinancialRoleSource: 'HEURISTIC',
            updatedAt: observedAt,
            workspaceId,
          });
          transactionsInserted += 1;
          if (item.status === 'DELETED') transactionsDeleted += 1;
        } else {
          const revision = changedFields(
            {
              ...existing,
              accountCurrencyAmountSigned: databaseDecimal(existing.accountCurrencyAmountSigned),
              billForecastMonth: databaseDate(existing.billForecastMonth),
              installmentTotalAmount: databaseDecimal(existing.installmentTotalAmount),
              providerAmountSigned: parseDecimalString(existing.providerAmountSigned),
              purchaseLocalDate: databaseDate(existing.purchaseLocalDate),
              transactionLocalDate: databaseDate(existing.transactionLocalDate),
            },
            existing.systemFinancialRoleSource === 'NONE' ||
              existing.systemFinancialRoleSource === 'HEURISTIC'
              ? incomingComparable
              : {
                  ...incomingComparable,
                  systemFinancialRole: existing.systemFinancialRole,
                },
          );
          await transaction
            .update(financialTransaction)
            .set({
              ...incomingComparable,
              latestRawObjectId,
              systemFinancialRole: sql`case
                when ${financialTransaction.systemFinancialRoleSource} in ('NONE', 'HEURISTIC')
                  then ${classification.role}
                else ${financialTransaction.systemFinancialRole}
              end`,
              systemFinancialRoleConfidence: sql`case
                when ${financialTransaction.systemFinancialRoleSource} in ('NONE', 'HEURISTIC')
                  then null
                else ${financialTransaction.systemFinancialRoleConfidence}
              end`,
              systemFinancialRoleSource: sql`case
                when ${financialTransaction.systemFinancialRoleSource} in ('NONE', 'HEURISTIC')
                  then 'HEURISTIC'
                else ${financialTransaction.systemFinancialRoleSource}
              end`,
              updatedAt: observedAt,
            })
            .where(
              and(
                eq(financialTransaction.workspaceId, workspaceId),
                eq(financialTransaction.id, existing.id),
              ),
            );
          if (revision !== null) {
            await transaction.insert(transactionRevision).values({
              actorType: 'WORKER',
              changeType:
                item.status === 'DELETED' && existing.status !== 'DELETED'
                  ? 'DELETE'
                  : 'PROVIDER_UPDATE',
              changedFields: revision,
              createdAt: observedAt,
              financialTransactionId: existing.id,
              workspaceId,
            });
          }
          if (revision !== null || rawSnapshotInserted) {
            if (item.status === 'DELETED' && existing.status !== 'DELETED') {
              transactionsDeleted += 1;
            } else {
              transactionsUpdated += 1;
            }
          }
        }

        earliestDate = earliest(earliestDate, transactionLocalDate);
        latestDate = latest(latestDate, transactionLocalDate);
      }

      if (earliestDate !== null && latestDate !== null) {
        await transaction
          .update(financialAccount)
          .set({
            providerHistoryEarliestDate: sql`least(coalesce(${financialAccount.providerHistoryEarliestDate}, ${earliestDate}), ${earliestDate})`,
            providerHistoryLatestDate: sql`greatest(coalesce(${financialAccount.providerHistoryLatestDate}, ${latestDate}), ${latestDate})`,
            updatedAt: observedAt,
          })
          .where(
            and(
              eq(financialAccount.workspaceId, workspaceId),
              eq(financialAccount.id, account.financialAccountId),
            ),
          );
      }
      await transaction
        .update(syncRun)
        .set({
          cursorState: {
            accountId: account.financialAccountId,
            nextCursor,
          },
          transactionsDeleted: sql`${syncRun.transactionsDeleted} + ${transactionsDeleted}`,
          transactionsInserted: sql`${syncRun.transactionsInserted} + ${transactionsInserted}`,
          transactionsSeen: sql`${syncRun.transactionsSeen} + ${transactions.length}`,
          transactionsUpdated: sql`${syncRun.transactionsUpdated} + ${transactionsUpdated}`,
        })
        .where(
          and(
            eq(syncRun.workspaceId, workspaceId),
            eq(syncRun.id, syncRunId),
            eq(syncRun.status, 'RUNNING'),
          ),
        );
      return {
        rawSnapshotsInserted,
        transactionsDeleted,
        transactionsInserted,
        transactionsSeen: transactions.length,
        transactionsUpdated,
      };
    });
  }

  public async completeAccount(
    workspaceId: string,
    syncRunId: string,
    financialAccountId: string,
    completedAt = new Date(),
  ): Promise<void> {
    const reachedProviderMaximum = sql`${financialAccount.providerHistoryEarliestDate} is not null
      and ${financialAccount.providerHistoryLatestDate} is not null
      and ${financialAccount.providerHistoryEarliestDate}
        <= (${financialAccount.providerHistoryLatestDate} - interval '12 months')::date`;
    const rows = await this.database
      .update(financialAccount)
      .set({
        historyCoverageNote: sql`case
          when ${financialAccount.historyCoverageStatus} = 'USER_EXTENDED_HISTORY'
            then ${financialAccount.historyCoverageNote}
          when ${reachedProviderMaximum}
            then 'Observed provider history spans at least the documented maximum window.'
          when ${financialAccount.providerHistoryEarliestDate} is null
            then 'Provider returned no dated transactions; historical completeness is unknown.'
          else 'Provider history begins ' || ${financialAccount.providerHistoryEarliestDate}::text
            || '; earlier activity may be unavailable.'
        end`,
        historyCoverageStatus: sql`case
          when ${financialAccount.historyCoverageStatus} = 'USER_EXTENDED_HISTORY'
            then 'USER_EXTENDED_HISTORY'
          when ${reachedProviderMaximum} then 'PROVIDER_MAXIMUM_RETRIEVED'
          else 'PARTIAL'
        end`,
        initialImportCompletedAt: sql`coalesce(${financialAccount.initialImportCompletedAt}, ${completedAt})`,
        lastSuccessfulSyncAt: completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(financialAccount.workspaceId, workspaceId),
          eq(financialAccount.id, financialAccountId),
          sql`exists (
            select 1 from ${syncRun}
            where ${syncRun.workspaceId} = ${workspaceId}
              and ${syncRun.id} = ${syncRunId}
              and ${syncRun.status} = 'RUNNING'
              and ${syncRun.providerConnectionId} = ${financialAccount.providerConnectionId}
          )`,
        ),
      )
      .returning({ id: financialAccount.id });
    if (rows.length !== 1) {
      throw new TransactionImportInvariantError('Transaction import account completion failed.');
    }
  }

  public async completeSync(
    workspaceId: string,
    syncRunId: string,
    completedAt = new Date(),
  ): Promise<TransactionSyncResult> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(syncRun)
        .set({ cursorState: {}, finishedAt: completedAt, status: 'SUCCEEDED' })
        .where(
          and(
            eq(syncRun.workspaceId, workspaceId),
            eq(syncRun.id, syncRunId),
            eq(syncRun.status, 'RUNNING'),
          ),
        )
        .returning({
          accountsSeen: syncRun.accountsSeen,
          providerConnectionId: syncRun.providerConnectionId,
          syncRunId: syncRun.id,
          transactionsDeleted: syncRun.transactionsDeleted,
          transactionsInserted: syncRun.transactionsInserted,
          transactionsSeen: syncRun.transactionsSeen,
          transactionsUpdated: syncRun.transactionsUpdated,
        });
      const completed = rows[0];
      if (completed === undefined) {
        throw new TransactionImportInvariantError('Transaction sync completion failed.');
      }
      await transaction
        .update(providerConnection)
        .set({ lastSuccessfulSyncAt: completedAt, updatedAt: completedAt })
        .where(
          and(
            eq(providerConnection.workspaceId, workspaceId),
            eq(providerConnection.id, completed.providerConnectionId),
          ),
        );
      return completed;
    });
  }

  public async failSync(
    workspaceId: string,
    syncRunId: string,
    failedAt = new Date(),
  ): Promise<void> {
    const rows = await this.database
      .update(syncRun)
      .set({
        errorSummary: 'TRANSACTION_IMPORT_FAILED',
        finishedAt: failedAt,
        status: 'FAILED',
      })
      .where(
        and(
          eq(syncRun.workspaceId, workspaceId),
          eq(syncRun.id, syncRunId),
          eq(syncRun.status, 'RUNNING'),
        ),
      )
      .returning({ id: syncRun.id });
    if (rows.length !== 1) {
      throw new TransactionImportInvariantError('Transaction sync failure recording failed.');
    }
  }
}
