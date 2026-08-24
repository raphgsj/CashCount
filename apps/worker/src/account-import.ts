import type {
  AccountImportResult,
  AccountImportTarget,
  PayloadEncryptionService,
} from '@cashcount/db';
import type { ProviderAccountDto } from '@cashcount/provider-core';

export interface AccountImportProvider {
  listAccounts(externalConnectionId: string): Promise<ProviderAccountDto[]>;
}

export interface AccountImportPersistence {
  getImportTarget(
    workspaceId: string,
    providerConnectionId: string,
  ): Promise<AccountImportTarget | null>;
  importAccounts(
    workspaceId: string,
    providerConnectionId: string,
    expectedExternalConnectionId: string,
    accounts: readonly ProviderAccountDto[],
    encryption: PayloadEncryptionService,
    observedAt?: Date,
  ): Promise<AccountImportResult>;
}

export interface ImportAccountsOptions {
  encryption: PayloadEncryptionService;
  observedAt?: Date;
  persistence: AccountImportPersistence;
  provider: AccountImportProvider;
  providerConnectionId: string;
  workspaceId: string;
}

export class AccountImportTargetUnavailableError extends Error {
  public constructor() {
    super('Account import target is unavailable.');
    this.name = 'AccountImportTargetUnavailableError';
  }
}

export class AccountImportProviderScopeError extends Error {
  public constructor() {
    super('Provider returned an account outside the assigned connection.');
    this.name = 'AccountImportProviderScopeError';
  }
}

export async function importAccounts(options: ImportAccountsOptions): Promise<AccountImportResult> {
  const target = await options.persistence.getImportTarget(
    options.workspaceId,
    options.providerConnectionId,
  );
  if (target === null || target.localStatus === 'DELETED' || target.localStatus === 'DISABLED') {
    throw new AccountImportTargetUnavailableError();
  }

  const accounts = await options.provider.listAccounts(target.externalConnectionId);
  if (accounts.some((account) => account.externalConnectionId !== target.externalConnectionId)) {
    throw new AccountImportProviderScopeError();
  }
  return options.persistence.importAccounts(
    options.workspaceId,
    options.providerConnectionId,
    target.externalConnectionId,
    accounts,
    options.encryption,
    options.observedAt,
  );
}
