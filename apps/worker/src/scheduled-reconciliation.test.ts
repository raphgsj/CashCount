import type { ReconciliationConnectionTarget } from '@cashcount/db';
import type { ProviderConnectionDto } from '@cashcount/provider-core';
import { PluggyHttpError } from '@cashcount/provider-pluggy';
import { describe, expect, it } from 'vitest';

import {
  parseReconciliationArguments,
  ReconciliationUsageError,
  runScheduledReconciliation,
  type ScheduledReconciliationOptions,
} from './scheduled-reconciliation.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const externalConnectionId = '30000000-0000-4000-8000-000000000001';
const reconciliationRunId = '40000000-0000-4000-8000-000000000001';
const now = new Date('2026-08-24T12:00:00.000Z');

function target(suffix = '000000000001'): ReconciliationConnectionTarget {
  return {
    externalConnectionId: `30000000-0000-4000-8000-${suffix}`,
    localStatus: 'ACTIVE',
    providerConnectionId: `20000000-0000-4000-8000-${suffix}`,
    workspaceId,
  };
}

function snapshot(
  localStatus: ProviderConnectionDto['localStatus'],
  externalId = externalConnectionId,
): ProviderConnectionDto {
  return {
    actionRequiredAt: null,
    consentExpiresAt: null,
    displayName: 'Synthetic Bank',
    errorCode: localStatus === 'REAUTH_REQUIRED' ? 'LOGIN_ERROR' : null,
    executionStatus: localStatus === 'ACTIVE' ? 'SUCCESS' : 'UPDATING',
    externalConnectionId: externalId,
    externalConnectorId: '601',
    itemStatus: localStatus === 'ACTIVE' ? 'UPDATED' : 'UPDATING',
    localStatus,
    providerUpdatedAt: now.toISOString(),
    raw: { synthetic: true },
  };
}

interface Harness {
  calls: string[];
  options: ScheduledReconciliationOptions;
}

function harness(responses: (Error | ProviderConnectionDto)[], targets = [target()]): Harness {
  const calls: string[] = [];
  const pending = [...responses];
  const options: ScheduledReconciliationOptions = {
    applyConnectionSnapshot: async (_workspaceId, _providerConnectionId, current) => {
      calls.push(`apply:${current.localStatus}`);
    },
    fullImport: async () => {
      calls.push('full-import');
    },
    maxPollAttempts: 3,
    now: () => now,
    persistence: {
      isConnectionEnabled: async () => {
        calls.push('enabled');
        return true;
      },
      listEnabledConnections: async () => {
        calls.push('list');
        return targets;
      },
      markConnectionAttempted: async () => {
        calls.push('attempted');
      },
      markConnectionDeleted: async () => {
        calls.push('deleted');
      },
      markConnectionSuccessful: async () => {
        calls.push('successful');
      },
      markConnectionSyncing: async () => {
        calls.push('syncing');
      },
      recordActionEvidence: async () => {
        calls.push('action-evidence');
      },
      tryRunExclusive: async (_workspaceId, action) => {
        calls.push('global-lock');
        return { acquired: true, value: await action() };
      },
      withConnectionLock: async (_workspaceId, _externalConnectionId, action) => {
        calls.push('connection-lock');
        return action();
      },
    },
    pollIntervalMs: 1,
    provider: {
      getConnection: async () => {
        calls.push('get-item');
        const response = pending.shift();
        if (response === undefined) throw new Error('Missing synthetic Item response.');
        if (response instanceof Error) throw response;
        return response;
      },
      requestConnectionRefresh: async () => {
        calls.push('request-refresh');
      },
    },
    reconciliationRunId,
    sleep: async () => {
      calls.push('sleep');
    },
    workspaceId,
  };
  return { calls, options };
}

describe('scheduled reconciliation', () => {
  it('requires an explicit canonical workspace for the one-shot command', () => {
    expect(parseReconciliationArguments(['--workspace', workspaceId])).toBe(workspaceId);
    expect(() => parseReconciliationArguments([])).toThrow(ReconciliationUsageError);
    expect(() => parseReconciliationArguments(['--workspace', 'not-a-uuid'])).toThrow(/workspace/u);
  });

  it('exits cleanly without provider access when a prior schedule owns the overlap lock', async () => {
    const test = harness([]);
    test.options.persistence.tryRunExclusive = async () => ({ acquired: false });

    await expect(runScheduledReconciliation(test.options)).resolves.toEqual({
      actionRequired: 0,
      connectionsDeleted: 0,
      connectionsFailed: 0,
      connectionsReconciled: 0,
      overlapSkipped: true,
      targetsSeen: 0,
    });
    expect(test.calls).toEqual([]);
  });

  it('requests refresh, polls to terminal, imports, rechecks health, and advances freshness', async () => {
    const test = harness([
      snapshot('ACTIVE'),
      snapshot('SYNCING'),
      snapshot('ACTIVE'),
      snapshot('ACTIVE'),
    ]);

    await expect(runScheduledReconciliation(test.options)).resolves.toMatchObject({
      connectionsFailed: 0,
      connectionsReconciled: 1,
      targetsSeen: 1,
    });
    expect(test.calls).toEqual([
      'global-lock',
      'list',
      'connection-lock',
      'enabled',
      'attempted',
      'get-item',
      'request-refresh',
      'syncing',
      'get-item',
      'sleep',
      'get-item',
      'full-import',
      'successful',
      'get-item',
      'apply:ACTIVE',
    ]);
  });

  it('maps user-action health without blind refresh or financial import', async () => {
    const test = harness([snapshot('REAUTH_REQUIRED')]);

    await expect(runScheduledReconciliation(test.options)).resolves.toMatchObject({
      actionRequired: 1,
      connectionsFailed: 0,
    });
    expect(test.calls).toContain('apply:REAUTH_REQUIRED');
    expect(test.calls).toContain('action-evidence');
    expect(test.calls).not.toContain('request-refresh');
    expect(test.calls).not.toContain('full-import');
  });

  it('reports an action state observed by the final post-import health check', async () => {
    const test = harness([snapshot('ACTIVE'), snapshot('ACTIVE'), snapshot('REAUTH_REQUIRED')]);

    await expect(runScheduledReconciliation(test.options)).resolves.toMatchObject({
      actionRequired: 1,
      connectionsFailed: 0,
      connectionsReconciled: 0,
    });
    expect(test.calls).toContain('full-import');
    expect(test.calls).toContain('successful');
    expect(test.calls).toContain('apply:REAUTH_REQUIRED');
    expect(test.calls).toContain('action-evidence');
  });

  it('treats provider 404 as deletion and preserves the command for remaining targets', async () => {
    const test = harness([new PluggyHttpError('GET', `/items/${externalConnectionId}`, 404)]);

    await expect(runScheduledReconciliation(test.options)).resolves.toMatchObject({
      connectionsDeleted: 1,
      connectionsFailed: 0,
    });
    expect(test.calls).toContain('deleted');
  });

  it('skips a connection disabled after target selection without misreporting deletion', async () => {
    const test = harness([]);
    test.options.persistence.isConnectionEnabled = async () => false;

    await expect(runScheduledReconciliation(test.options)).resolves.toMatchObject({
      actionRequired: 0,
      connectionsDeleted: 0,
      connectionsFailed: 0,
      connectionsReconciled: 0,
      targetsSeen: 1,
    });
    expect(test.calls).not.toContain('get-item');
  });

  it('bounds in-progress polling and reports a target failure without leaking provider errors', async () => {
    const test = harness([snapshot('SYNCING'), snapshot('SYNCING'), snapshot('SYNCING')]);
    test.options.maxPollAttempts = 2;

    await expect(runScheduledReconciliation(test.options)).resolves.toMatchObject({
      connectionsFailed: 1,
      connectionsReconciled: 0,
    });
    expect(test.calls.filter((call) => call === 'sleep')).toHaveLength(1);
  });

  it('observes current data after a documented refresh conflict', async () => {
    const test = harness([snapshot('ACTIVE'), snapshot('ACTIVE'), snapshot('ACTIVE')]);
    test.options.provider.requestConnectionRefresh = async () => {
      test.calls.push('request-refresh');
      throw new PluggyHttpError('PATCH', `/items/${externalConnectionId}`, 409);
    };

    await expect(runScheduledReconciliation(test.options)).resolves.toMatchObject({
      connectionsFailed: 0,
      connectionsReconciled: 1,
    });
    expect(test.calls).not.toContain('syncing');
    expect(test.calls).toContain('full-import');
  });

  it('rejects invalid polling bounds before acquiring any lock', async () => {
    const test = harness([]);
    test.options.maxPollAttempts = 0;

    await expect(runScheduledReconciliation(test.options)).rejects.toThrow(/maxPollAttempts/u);
    expect(test.calls).toEqual([]);
  });

  it('uses the configured target identity rather than accepting a provider substitution', async () => {
    const test = harness([snapshot('ACTIVE', '50000000-0000-4000-8000-000000000001')]);

    await expect(runScheduledReconciliation(test.options)).resolves.toMatchObject({
      connectionsFailed: 1,
    });
    expect(test.calls).not.toContain('full-import');
  });
});
