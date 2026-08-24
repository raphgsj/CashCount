import type { ReconciliationConnectionTarget, ReconciliationRepository } from '@cashcount/db';
import type { ProviderConnectionDto } from '@cashcount/provider-core';
import { PluggyHttpError, type PluggyDataClient } from '@cashcount/provider-pluggy';

const actionableStatuses = new Set([
  'PROVIDER_ERROR',
  'REAUTH_REQUIRED',
  'USER_ACTION_REQUIRED',
  'USER_INPUT_REQUIRED',
] as const);

type ActionableStatus =
  'PROVIDER_ERROR' | 'REAUTH_REQUIRED' | 'USER_ACTION_REQUIRED' | 'USER_INPUT_REQUIRED';

export type ConnectionReconciliationOutcome =
  'ACTION_REQUIRED' | 'DELETED' | 'RECONCILED' | 'SKIPPED';

const workspaceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const defaultReconciliationPollIntervalMs = 5_000;
export const defaultReconciliationMaxPollAttempts = 120;

export interface ScheduledReconciliationResult {
  actionRequired: number;
  connectionsDeleted: number;
  connectionsFailed: number;
  connectionsReconciled: number;
  overlapSkipped: boolean;
  targetsSeen: number;
}

export interface ScheduledReconciliationOptions {
  applyConnectionSnapshot(
    workspaceId: string,
    providerConnectionId: string,
    snapshot: ProviderConnectionDto,
  ): Promise<void>;
  fullImport(workspaceId: string, providerConnectionId: string): Promise<unknown>;
  maxPollAttempts?: number;
  now?: () => Date;
  persistence: Pick<
    ReconciliationRepository,
    | 'isConnectionEnabled'
    | 'listEnabledConnections'
    | 'markConnectionAttempted'
    | 'markConnectionDeleted'
    | 'markConnectionSuccessful'
    | 'markConnectionSyncing'
    | 'recordActionEvidence'
    | 'tryRunExclusive'
    | 'withConnectionLock'
  >;
  pollIntervalMs?: number;
  provider: Pick<PluggyDataClient, 'getConnection' | 'requestConnectionRefresh'>;
  reconciliationRunId: string;
  signal?: AbortSignal;
  sleep?: (delayMs: number) => Promise<void>;
  workspaceId: string;
}

export class ReconciliationPollingTimeoutError extends Error {
  public constructor() {
    super('Provider Item did not settle within the reconciliation polling bound.');
    this.name = 'ReconciliationPollingTimeoutError';
  }
}

export class ReconciliationAbortedError extends Error {
  public constructor() {
    super('Connection reconciliation was interrupted.');
    this.name = 'ReconciliationAbortedError';
  }
}

export class ReconciliationUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReconciliationUsageError';
  }
}

export function parseReconciliationArguments(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== '--workspace') {
    throw new ReconciliationUsageError('Usage: pnpm sync:reconcile --workspace <workspace-uuid>');
  }
  const workspaceId = arguments_[1] ?? '';
  if (!workspaceIdPattern.test(workspaceId)) {
    throw new ReconciliationUsageError('The workspace must be a canonical UUID.');
  }
  return workspaceId;
}

function requireBoundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function assertSnapshotIdentity(
  target: ReconciliationConnectionTarget,
  snapshot: ProviderConnectionDto,
): void {
  if (snapshot.externalConnectionId !== target.externalConnectionId) {
    throw new TypeError('Provider returned a different Item identity during reconciliation.');
  }
}

function abortIfRequested(options: ScheduledReconciliationOptions): void {
  if (options.signal?.aborted === true) throw new ReconciliationAbortedError();
}

async function recordAction(
  options: ScheduledReconciliationOptions,
  target: ReconciliationConnectionTarget,
  snapshot: ProviderConnectionDto,
): Promise<void> {
  if (!actionableStatuses.has(snapshot.localStatus as ActionableStatus)) return;
  await options.persistence.recordActionEvidence(
    target.workspaceId,
    target.providerConnectionId,
    options.reconciliationRunId,
    snapshot.localStatus as ActionableStatus,
    options.now?.() ?? new Date(),
  );
}

async function applyNonActiveSnapshot(
  options: ScheduledReconciliationOptions,
  target: ReconciliationConnectionTarget,
  snapshot: ProviderConnectionDto,
): Promise<ConnectionReconciliationOutcome> {
  if (snapshot.localStatus === 'DELETED') {
    await options.persistence.markConnectionDeleted(
      target.workspaceId,
      target.providerConnectionId,
      options.now?.() ?? new Date(),
    );
    return 'DELETED';
  }
  await options.applyConnectionSnapshot(target.workspaceId, target.providerConnectionId, snapshot);
  await recordAction(options, target, snapshot);
  return 'ACTION_REQUIRED';
}

async function getCurrent(
  options: ScheduledReconciliationOptions,
  target: ReconciliationConnectionTarget,
): Promise<ProviderConnectionDto | null> {
  try {
    const snapshot = await options.provider.getConnection(target.externalConnectionId);
    assertSnapshotIdentity(target, snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof PluggyHttpError && error.status === 404) return null;
    throw error;
  }
}

async function waitForSettledItem(
  options: ScheduledReconciliationOptions,
  target: ReconciliationConnectionTarget,
  maxPollAttempts: number,
  pollIntervalMs: number,
  sleep: (delayMs: number) => Promise<void>,
): Promise<ProviderConnectionDto | null> {
  for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
    abortIfRequested(options);
    const snapshot = await getCurrent(options, target);
    if (snapshot === null || snapshot.localStatus !== 'SYNCING') return snapshot;
    if (attempt === maxPollAttempts) throw new ReconciliationPollingTimeoutError();
    await sleep(pollIntervalMs);
  }
  throw new ReconciliationPollingTimeoutError();
}

async function reconcileTarget(
  options: ScheduledReconciliationOptions,
  target: ReconciliationConnectionTarget,
  maxPollAttempts: number,
  pollIntervalMs: number,
  sleep: (delayMs: number) => Promise<void>,
): Promise<ConnectionReconciliationOutcome> {
  if (target.workspaceId !== options.workspaceId) {
    throw new TypeError('Connection reconciliation target is outside the configured workspace.');
  }
  return options.persistence.withConnectionLock(
    target.workspaceId,
    target.externalConnectionId,
    async () => {
      abortIfRequested(options);
      if (
        !(await options.persistence.isConnectionEnabled(
          target.workspaceId,
          target.providerConnectionId,
        ))
      ) {
        return 'SKIPPED';
      }
      await options.persistence.markConnectionAttempted(
        target.workspaceId,
        target.providerConnectionId,
        options.now?.() ?? new Date(),
      );
      abortIfRequested(options);
      const initial = await getCurrent(options, target);
      if (initial === null) {
        await options.persistence.markConnectionDeleted(
          target.workspaceId,
          target.providerConnectionId,
          options.now?.() ?? new Date(),
        );
        return 'DELETED';
      }
      if (
        initial.localStatus === 'DELETED' ||
        initial.localStatus === 'REAUTH_REQUIRED' ||
        initial.localStatus === 'USER_ACTION_REQUIRED' ||
        initial.localStatus === 'USER_INPUT_REQUIRED'
      ) {
        return applyNonActiveSnapshot(options, target, initial);
      }

      if (initial.localStatus === 'ACTIVE' || initial.localStatus === 'PROVIDER_ERROR') {
        try {
          await options.provider.requestConnectionRefresh(target.externalConnectionId);
          await options.persistence.markConnectionSyncing(
            target.workspaceId,
            target.providerConnectionId,
            options.now?.() ?? new Date(),
          );
        } catch (error) {
          if (error instanceof PluggyHttpError && error.status === 404) {
            await options.persistence.markConnectionDeleted(
              target.workspaceId,
              target.providerConnectionId,
              options.now?.() ?? new Date(),
            );
            return 'DELETED';
          }
          if (!(error instanceof PluggyHttpError) || ![400, 409].includes(error.status)) {
            throw error;
          }
        }
      } else {
        await options.persistence.markConnectionSyncing(
          target.workspaceId,
          target.providerConnectionId,
          options.now?.() ?? new Date(),
        );
      }

      const settled = await waitForSettledItem(
        options,
        target,
        maxPollAttempts,
        pollIntervalMs,
        sleep,
      );
      if (settled === null) {
        await options.persistence.markConnectionDeleted(
          target.workspaceId,
          target.providerConnectionId,
          options.now?.() ?? new Date(),
        );
        return 'DELETED';
      }
      if (settled.localStatus !== 'ACTIVE') {
        return applyNonActiveSnapshot(options, target, settled);
      }

      await options.fullImport(target.workspaceId, target.providerConnectionId);
      abortIfRequested(options);
      await options.persistence.markConnectionSuccessful(
        target.workspaceId,
        target.providerConnectionId,
        options.now?.() ?? new Date(),
      );
      const finalSnapshot = await getCurrent(options, target);
      if (finalSnapshot === null) {
        await options.persistence.markConnectionDeleted(
          target.workspaceId,
          target.providerConnectionId,
          options.now?.() ?? new Date(),
        );
        return 'DELETED';
      }
      if (finalSnapshot.localStatus !== 'ACTIVE') {
        return applyNonActiveSnapshot(options, target, finalSnapshot);
      }
      await options.applyConnectionSnapshot(
        target.workspaceId,
        target.providerConnectionId,
        finalSnapshot,
      );
      return 'RECONCILED';
    },
  );
}

export async function runConnectionReconciliation(
  options: ScheduledReconciliationOptions,
  target: ReconciliationConnectionTarget,
): Promise<ConnectionReconciliationOutcome> {
  const maxPollAttempts = options.maxPollAttempts ?? defaultReconciliationMaxPollAttempts;
  const pollIntervalMs = options.pollIntervalMs ?? defaultReconciliationPollIntervalMs;
  requireBoundedInteger('maxPollAttempts', maxPollAttempts, 1, 10_000);
  requireBoundedInteger('pollIntervalMs', pollIntervalMs, 1, 300_000);
  const sleep =
    options.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  return reconcileTarget(options, target, maxPollAttempts, pollIntervalMs, sleep);
}

export async function runScheduledReconciliation(
  options: ScheduledReconciliationOptions,
): Promise<ScheduledReconciliationResult> {
  const maxPollAttempts = options.maxPollAttempts ?? defaultReconciliationMaxPollAttempts;
  const pollIntervalMs = options.pollIntervalMs ?? defaultReconciliationPollIntervalMs;
  requireBoundedInteger('maxPollAttempts', maxPollAttempts, 1, 10_000);
  requireBoundedInteger('pollIntervalMs', pollIntervalMs, 1, 300_000);
  const sleep =
    options.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  const locked = await options.persistence.tryRunExclusive(options.workspaceId, async () => {
    const targets = await options.persistence.listEnabledConnections(options.workspaceId);
    const result: ScheduledReconciliationResult = {
      actionRequired: 0,
      connectionsDeleted: 0,
      connectionsFailed: 0,
      connectionsReconciled: 0,
      overlapSkipped: false,
      targetsSeen: targets.length,
    };
    for (const target of targets) {
      try {
        const outcome = await reconcileTarget(
          options,
          target,
          maxPollAttempts,
          pollIntervalMs,
          sleep,
        );
        if (outcome === 'ACTION_REQUIRED') result.actionRequired += 1;
        if (outcome === 'DELETED') result.connectionsDeleted += 1;
        if (outcome === 'RECONCILED') result.connectionsReconciled += 1;
      } catch {
        result.connectionsFailed += 1;
      }
    }
    return result;
  });
  if (!locked.acquired) {
    return {
      actionRequired: 0,
      connectionsDeleted: 0,
      connectionsFailed: 0,
      connectionsReconciled: 0,
      overlapSkipped: true,
      targetsSeen: 0,
    };
  }
  return locked.value;
}
