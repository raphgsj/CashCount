import { PayloadEncryptionService, type AccountImportResult } from '@cashcount/db';
import { providerAccountSchema, type ProviderAccountDto } from '@cashcount/provider-core';
import { describe, expect, it, vi } from 'vitest';

import {
  AccountImportProviderScopeError,
  AccountImportTargetUnavailableError,
  importAccounts,
  type AccountImportPersistence,
} from './account-import.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const providerConnectionId = '22222222-2222-4222-8222-222222222222';
const externalConnectionId = '33333333-3333-4333-8333-333333333333';
const result: AccountImportResult = {
  accountsInserted: 1,
  accountsSeen: 1,
  accountsUpdated: 0,
  rawSnapshotsInserted: 1,
};

function account(overrides: Partial<ProviderAccountDto> = {}): ProviderAccountDto {
  return providerAccountSchema.parse({
    accountSubtype: 'CHECKING_ACCOUNT',
    accountType: 'CHECKING',
    availableBalance: '123.450000',
    availableCreditLimit: null,
    closingDay: null,
    creditLimit: null,
    currency: 'BRL',
    currentBalance: '123.450000',
    dueDay: null,
    externalAccountId: '44444444-4444-4444-8444-444444444444',
    externalConnectionId,
    institutionName: 'Synthetic Fixture Bank',
    isActive: true,
    maskedNumber: '6789',
    name: 'Synthetic checking',
    providerUpdatedAt: '2026-08-23T12:00:00.000Z',
    raw: { number: '000123456789' },
    ...overrides,
  });
}

function encryption(): PayloadEncryptionService {
  return new PayloadEncryptionService({
    activeKeyVersion: 1,
    keyring: new Map([[1, new Uint8Array(32).fill(7)]]),
  });
}

function persistence(
  target: Awaited<ReturnType<AccountImportPersistence['getImportTarget']>> = {
    externalConnectionId,
    localStatus: 'ACTIVE',
  },
): AccountImportPersistence {
  return {
    getImportTarget: vi.fn(async () => target),
    importAccounts: vi.fn(async () => result),
  };
}

describe('account import orchestration', () => {
  it('resolves a workspace-scoped target before provider access', async () => {
    const provider = { listAccounts: vi.fn(async () => [account()]) };

    await expect(
      importAccounts({
        encryption: encryption(),
        persistence: persistence(null),
        provider,
        providerConnectionId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(AccountImportTargetUnavailableError);
    expect(provider.listAccounts).not.toHaveBeenCalled();
  });

  it.each(['DELETED', 'DISABLED'])('does not import a %s connection', async (localStatus) => {
    const provider = { listAccounts: vi.fn(async () => [account()]) };

    await expect(
      importAccounts({
        encryption: encryption(),
        persistence: persistence({ externalConnectionId, localStatus }),
        provider,
        providerConnectionId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(AccountImportTargetUnavailableError);
    expect(provider.listAccounts).not.toHaveBeenCalled();
  });

  it('rejects provider accounts from another connection before persistence', async () => {
    const storage = persistence();

    await expect(
      importAccounts({
        encryption: encryption(),
        persistence: storage,
        provider: {
          listAccounts: vi.fn(async () => [
            account({ externalConnectionId: '55555555-5555-4555-8555-555555555555' }),
          ]),
        },
        providerConnectionId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(AccountImportProviderScopeError);
    expect(storage.importAccounts).not.toHaveBeenCalled();
  });

  it('imports validated accounts with explicit workspace, connection, encryption, and time', async () => {
    const accounts = [account()];
    const storage = persistence();
    const provider = { listAccounts: vi.fn(async () => accounts) };
    const payloadEncryption = encryption();
    const observedAt = new Date('2026-08-23T13:00:00.000Z');

    await expect(
      importAccounts({
        encryption: payloadEncryption,
        observedAt,
        persistence: storage,
        provider,
        providerConnectionId,
        workspaceId,
      }),
    ).resolves.toEqual(result);
    expect(provider.listAccounts).toHaveBeenCalledWith(externalConnectionId);
    expect(storage.importAccounts).toHaveBeenCalledWith(
      workspaceId,
      providerConnectionId,
      externalConnectionId,
      accounts,
      payloadEncryption,
      observedAt,
    );
  });
});
