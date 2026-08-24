import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ProviderAccountDto } from '@cashcount/provider-core';

import { canonicalJsonSha256, type PayloadEncryptionService } from './encryption.js';
import { financialAccount, providerConnection, providerRawObject } from './schema.js';
import type * as schema from './schema.js';

export interface AccountImportTarget {
  externalConnectionId: string;
  localStatus: string;
}

export interface AccountImportResult {
  accountsInserted: number;
  accountsSeen: number;
  accountsUpdated: number;
  rawSnapshotsInserted: number;
}

export class AccountImportInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AccountImportInvariantError';
  }
}

function instant(value: null | string): Date | null {
  return value === null ? null : new Date(value);
}

export class AccountImportRepository {
  public constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  public async getImportTarget(
    workspaceId: string,
    providerConnectionId: string,
  ): Promise<AccountImportTarget | null> {
    const rows = await this.database
      .select({
        externalConnectionId: providerConnection.externalConnectionId,
        localStatus: providerConnection.localStatus,
      })
      .from(providerConnection)
      .where(
        and(
          eq(providerConnection.workspaceId, workspaceId),
          eq(providerConnection.id, providerConnectionId),
          eq(providerConnection.provider, 'PLUGGY'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  public async importAccounts(
    workspaceId: string,
    providerConnectionId: string,
    expectedExternalConnectionId: string,
    accounts: readonly ProviderAccountDto[],
    encryption: PayloadEncryptionService,
    observedAt = new Date(),
  ): Promise<AccountImportResult> {
    const externalAccountIds = new Set(accounts.map((account) => account.externalAccountId));
    if (externalAccountIds.size !== accounts.length) {
      throw new AccountImportInvariantError('Provider returned duplicate account identities.');
    }
    if (accounts.some((account) => account.externalConnectionId !== expectedExternalConnectionId)) {
      throw new AccountImportInvariantError(
        'Provider returned an account for a different connection.',
      );
    }

    return this.database.transaction(async (transaction) => {
      const targets = await transaction
        .select({
          externalConnectionId: providerConnection.externalConnectionId,
          localStatus: providerConnection.localStatus,
        })
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
      const target = targets[0];
      if (
        target === undefined ||
        target.externalConnectionId !== expectedExternalConnectionId ||
        target.localStatus === 'DELETED' ||
        target.localStatus === 'DISABLED'
      ) {
        throw new AccountImportInvariantError('Account import target is unavailable.');
      }

      let accountsInserted = 0;
      let accountsUpdated = 0;
      let rawSnapshotsInserted = 0;

      for (const account of accounts) {
        const existingRows = await transaction
          .select({
            id: financialAccount.id,
            latestRawObjectId: financialAccount.latestRawObjectId,
          })
          .from(financialAccount)
          .where(
            and(
              eq(financialAccount.workspaceId, workspaceId),
              eq(financialAccount.provider, 'PLUGGY'),
              eq(financialAccount.externalAccountId, account.externalAccountId),
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
                eq(providerRawObject.entityType, 'ACCOUNT'),
                eq(providerRawObject.externalId, account.externalAccountId),
              ),
            )
            .limit(1);
          latestPayloadHash = rawRows[0]?.payloadSha256 ?? null;
        }

        const payloadHash = canonicalJsonSha256(account.raw);
        if (latestPayloadHash !== payloadHash) {
          latestRawObjectId = randomUUID();
          const envelope = encryption.encryptJson(account.raw, {
            entityType: 'ACCOUNT',
            externalId: account.externalAccountId,
            provider: 'PLUGGY',
            recordId: latestRawObjectId,
            storageTable: 'provider_raw_object',
            workspaceId,
          });
          await transaction.insert(providerRawObject).values({
            canonicalizationVersion: envelope.canonicalizationVersion,
            entityType: 'ACCOUNT',
            externalId: account.externalAccountId,
            id: latestRawObjectId,
            keyVersion: envelope.keyVersion,
            observedAt,
            payloadCiphertext: Buffer.from(envelope.ciphertext),
            payloadIv: Buffer.from(envelope.nonce),
            payloadSha256: envelope.payloadSha256,
            payloadTag: Buffer.from(envelope.authenticationTag),
            provider: 'PLUGGY',
            providerUpdatedAt: instant(account.providerUpdatedAt),
            workspaceId,
          });
          rawSnapshotsInserted += 1;
        }
        if (latestRawObjectId === null) {
          throw new AccountImportInvariantError('Account raw snapshot resolution failed.');
        }

        await transaction
          .insert(financialAccount)
          .values({
            accountSubtype: account.accountSubtype,
            accountType: account.accountType,
            availableBalance: account.availableBalance,
            availableCreditLimit: account.availableCreditLimit,
            closingDay: account.closingDay,
            creditLimit: account.creditLimit,
            currency: account.currency,
            currentBalance: account.currentBalance,
            dueDay: account.dueDay,
            externalAccountId: account.externalAccountId,
            institutionName: account.institutionName,
            isActive: account.isActive,
            lastSuccessfulSyncAt: observedAt,
            latestRawObjectId,
            maskedNumber: account.maskedNumber,
            name: account.name,
            provider: 'PLUGGY',
            providerConnectionId,
            providerUpdatedAt: instant(account.providerUpdatedAt),
            workspaceId,
          })
          .onConflictDoUpdate({
            set: {
              accountSubtype: account.accountSubtype,
              accountType: account.accountType,
              availableBalance: account.availableBalance,
              availableCreditLimit: account.availableCreditLimit,
              closingDay: account.closingDay,
              creditLimit: account.creditLimit,
              currency: account.currency,
              currentBalance: account.currentBalance,
              dueDay: account.dueDay,
              institutionName: account.institutionName,
              isActive: account.isActive,
              lastSuccessfulSyncAt: observedAt,
              latestRawObjectId,
              maskedNumber: account.maskedNumber,
              name: account.name,
              providerConnectionId,
              providerUpdatedAt: instant(account.providerUpdatedAt),
              updatedAt: observedAt,
            },
            target: [
              financialAccount.workspaceId,
              financialAccount.provider,
              financialAccount.externalAccountId,
            ],
          });
        if (existing === undefined) accountsInserted += 1;
        else accountsUpdated += 1;
      }

      return {
        accountsInserted,
        accountsSeen: accounts.length,
        accountsUpdated,
        rawSnapshotsInserted,
      };
    });
  }
}
