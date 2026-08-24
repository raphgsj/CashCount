import type { ProviderConnectionDto } from '@cashcount/provider-core';
import { describe, expect, it, vi } from 'vitest';

import {
  ConnectionDiscoveryUsageError,
  discoverConnections,
  parseConnectionDiscoveryArguments,
  type ConnectionDiscoveryRepository,
} from './discover-connections.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';

function connection(overrides: Partial<ProviderConnectionDto> = {}): ProviderConnectionDto {
  return {
    actionRequiredAt: null,
    consentExpiresAt: null,
    displayName: 'Synthetic Fixture Bank',
    errorCode: null,
    executionStatus: 'SUCCESS',
    externalConnectionId: '22222222-2222-4222-8222-222222222222',
    externalConnectorId: '601',
    itemStatus: 'UPDATED',
    localStatus: 'ACTIVE',
    providerUpdatedAt: '2026-08-23T12:00:00.000Z',
    raw: { privateMarker: 'must-not-print' },
    ...overrides,
  };
}

function repository(exists = true): ConnectionDiscoveryRepository {
  return {
    assignDiscoveredConnections: vi.fn(async (_workspaceId, connections) =>
      connections.map(() => ({ assigned: true })),
    ),
    workspaceExists: vi.fn(async () => exists),
  };
}

describe('connection discovery', () => {
  it('requires exactly one explicit canonical workspace argument', () => {
    expect(parseConnectionDiscoveryArguments(['--workspace', workspaceId])).toBe(workspaceId);
    expect(() => parseConnectionDiscoveryArguments([])).toThrow(ConnectionDiscoveryUsageError);
    expect(() => parseConnectionDiscoveryArguments(['--workspace', 'not-a-uuid'])).toThrow(
      ConnectionDiscoveryUsageError,
    );
    expect(() =>
      parseConnectionDiscoveryArguments(['--workspace', workspaceId, '--extra']),
    ).toThrow(ConnectionDiscoveryUsageError);
  });

  it('validates the workspace before making any provider request', async () => {
    const provider = { listConnections: vi.fn(async () => [connection()]) };

    await expect(
      discoverConnections({
        provider,
        repository: repository(false),
        workspaceId,
        writeLine: vi.fn(),
      }),
    ).rejects.toThrow('assigned workspace does not exist');
    expect(provider.listConnections).not.toHaveBeenCalled();
  });

  it('assigns connections and prints only sanitized labels and local states', async () => {
    const connections = [
      connection(),
      connection({
        displayName: 'Fixture\nBank\u0000 With     Spaces',
        externalConnectionId: '33333333-3333-4333-8333-333333333333',
        externalConnectorId: '999',
        localStatus: 'USER_ACTION_REQUIRED',
      }),
    ];
    const provider = { listConnections: vi.fn(async () => connections) };
    const persistence = repository();
    const lines: string[] = [];

    const result = await discoverConnections({
      provider,
      repository: persistence,
      workspaceId,
      writeLine: (line) => lines.push(line),
    });

    expect(result).toEqual({
      assignedCount: 2,
      safeLabels: [
        'Synthetic Fixture Bank — ACTIVE',
        'Fixture Bank With Spaces — USER_ACTION_REQUIRED',
      ],
    });
    expect(persistence.assignDiscoveredConnections).toHaveBeenCalledWith(workspaceId, connections);
    const output = lines.join('\n');
    expect(output).toContain('Assigned 2 connection(s).');
    expect(output).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(output).not.toContain('33333333-3333-4333-8333-333333333333');
    expect(output).not.toContain('601');
    expect(output).not.toContain('999');
    expect(output).not.toContain('must-not-print');
  });

  it('does not print a success summary when assignment fails', async () => {
    const persistence = repository();
    persistence.assignDiscoveredConnections = vi.fn(async () => {
      throw new Error('synthetic persistence failure');
    });
    const writeLine = vi.fn();

    await expect(
      discoverConnections({
        provider: { listConnections: vi.fn(async () => [connection()]) },
        repository: persistence,
        workspaceId,
        writeLine,
      }),
    ).rejects.toThrow('synthetic persistence failure');
    expect(writeLine).not.toHaveBeenCalled();
  });
});
