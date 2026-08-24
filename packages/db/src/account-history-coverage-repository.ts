import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { parseBankDate, type BankDate } from '@cashcount/domain';

import { financialAccount } from './schema.js';
import type * as schema from './schema.js';

export type AccountHistoryCoverageStatus =
  'PARTIAL' | 'PROVIDER_MAXIMUM_RETRIEVED' | 'UNKNOWN' | 'USER_EXTENDED_HISTORY';

export interface IncompleteHistoryWarning {
  accountId: string;
  availableFrom: BankDate | null;
  code: 'INCOMPLETE_HISTORY';
  coverageStatus: AccountHistoryCoverageStatus;
  requestedFrom: BankDate;
}

export interface AccountHistoryCoverage {
  accountId: string;
  accountType: string;
  coverageNote: string | null;
  coverageStatus: AccountHistoryCoverageStatus;
  providerEarliestDate: BankDate | null;
  providerLatestDate: BankDate | null;
  warning: IncompleteHistoryWarning | null;
  workspaceId: string;
}

function databaseDate(value: Date | null | string): BankDate | null {
  if (value === null) return null;
  return parseBankDate(value instanceof Date ? value.toISOString().slice(0, 10) : value);
}

export class AccountHistoryCoverageRepository {
  public constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  public async getForRange(
    workspaceId: string,
    requestedFrom: string,
    accountIds?: readonly string[],
  ): Promise<AccountHistoryCoverage[]> {
    const from = parseBankDate(requestedFrom);
    if (accountIds !== undefined && accountIds.length === 0) return [];
    const rows = await this.database
      .select({
        accountId: financialAccount.id,
        accountType: financialAccount.accountType,
        coverageNote: financialAccount.historyCoverageNote,
        coverageStatus: financialAccount.historyCoverageStatus,
        providerEarliestDate: financialAccount.providerHistoryEarliestDate,
        providerLatestDate: financialAccount.providerHistoryLatestDate,
        workspaceId: financialAccount.workspaceId,
      })
      .from(financialAccount)
      .where(
        and(
          eq(financialAccount.workspaceId, workspaceId),
          isNull(financialAccount.deletedAt),
          accountIds === undefined ? undefined : inArray(financialAccount.id, accountIds),
        ),
      )
      .orderBy(financialAccount.id);

    return rows.map((row) => {
      const providerEarliestDate = databaseDate(row.providerEarliestDate);
      const providerLatestDate = databaseDate(row.providerLatestDate);
      const coverageStatus = row.coverageStatus as AccountHistoryCoverageStatus;
      const warning =
        providerEarliestDate !== null && from >= providerEarliestDate
          ? null
          : {
              accountId: row.accountId,
              availableFrom: providerEarliestDate,
              code: 'INCOMPLETE_HISTORY' as const,
              coverageStatus,
              requestedFrom: from,
            };
      return {
        accountId: row.accountId,
        accountType: row.accountType,
        coverageNote: row.coverageNote,
        coverageStatus,
        providerEarliestDate,
        providerLatestDate,
        warning,
        workspaceId: row.workspaceId,
      };
    });
  }
}
