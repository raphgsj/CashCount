import type { ProviderConnectionLocalStatus } from '@cashcount/provider-core';

export interface PluggyItemLifecycleInput {
  errorCode: null | string;
  event: null | string;
  executionStatus: null | string;
  itemStatus: null | string;
}

const reauthenticationStatuses = new Set([
  'ACCOUNT_CREDENTIALS_RESET',
  'INVALID_CREDENTIALS',
  'USER_AUTHORIZATION_REVOKED',
]);

const userActionStatuses = new Set([
  'USER_AUTHORIZATION_NOT_GRANTED',
  'USER_AUTHORIZATION_PENDING',
  'WAITING_USER_ACTION',
]);

const transitiveExecutionStatuses = new Set([
  'ACCOUNTS_IN_PROGRESS',
  'CREATED',
  'CREDITCARDS_IN_PROGRESS',
  'IDENTITY_IN_PROGRESS',
  'INVESTMENT_TRANSACTIONS_IN_PROGRESS',
  'LOGIN_IN_PROGRESS',
  'LOGIN_MFA_IN_PROGRESS',
  'MERGING',
  'PAYMENT_DATA_IN_PROGRESS',
  'TRANSACTIONS_IN_PROGRESS',
]);

function includes(values: ReadonlySet<string>, ...candidates: (null | string)[]): boolean {
  return candidates.some((candidate) => candidate !== null && values.has(candidate));
}

/**
 * Maps only bounded Pluggy lifecycle codes. Provider messages never cross this boundary.
 * Unknown or contradictory snapshots fail closed instead of presenting stale data as healthy.
 */
export function mapPluggyItemLifecycle(
  input: PluggyItemLifecycleInput,
): ProviderConnectionLocalStatus {
  if (input.event === 'item/deleted') {
    return 'DELETED';
  }

  if (
    input.itemStatus === 'LOGIN_ERROR' ||
    includes(reauthenticationStatuses, input.executionStatus, input.errorCode)
  ) {
    return 'REAUTH_REQUIRED';
  }

  if (
    input.itemStatus === 'WAITING_USER_INPUT' ||
    input.executionStatus === 'WAITING_USER_INPUT' ||
    input.event === 'item/waiting_user_input'
  ) {
    return 'USER_INPUT_REQUIRED';
  }

  if (
    input.itemStatus === 'WAITING_USER_ACTION' ||
    includes(userActionStatuses, input.executionStatus, input.errorCode) ||
    input.event === 'item/waiting_user_action'
  ) {
    return 'USER_ACTION_REQUIRED';
  }

  if (
    input.itemStatus === 'UPDATED' &&
    (input.executionStatus === 'SUCCESS' || input.executionStatus === 'PARTIAL_SUCCESS')
  ) {
    return 'ACTIVE';
  }

  if (
    input.itemStatus === 'UPDATING' ||
    includes(transitiveExecutionStatuses, input.executionStatus) ||
    input.event === 'item/login_succeeded'
  ) {
    return 'SYNCING';
  }

  return 'PROVIDER_ERROR';
}
