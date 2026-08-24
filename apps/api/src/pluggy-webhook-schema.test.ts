import { describe, expect, it } from 'vitest';

import {
  pluggyWebhookPayloadSchema,
  supportedPluggyWebhookEvents,
} from './pluggy-webhook-schema.js';

const ids = {
  account: '20000000-0000-4000-8000-000000000001',
  event: '10000000-0000-4000-8000-000000000001',
  item: '30000000-0000-4000-8000-000000000001',
  transaction: '40000000-0000-4000-8000-000000000001',
};

function fixture(event: (typeof supportedPluggyWebhookEvents)[number]): Record<string, unknown> {
  const common = { event, eventId: ids.event, itemId: ids.item };
  if (event === 'item/error') {
    return { ...common, error: { code: 'USER_INPUT_TIMEOUT', message: 'Synthetic error' } };
  }
  if (event === 'transactions/created') {
    return {
      ...common,
      accountId: ids.account,
      createdTransactionsLinkV2: `https://api.pluggy.ai/v2/transactions?accountId=${ids.account}&createdAtFrom=2026-08-23T12:00:00.000Z`,
      transactionsCreatedAtFrom: '2026-08-23T12:00:00.000Z',
      transactionsCount: 1,
    };
  }
  if (event === 'transactions/updated' || event === 'transactions/deleted') {
    return {
      ...common,
      accountId: ids.account,
      transactionIds: [ids.transaction],
      transactionsCount: 1,
    };
  }
  return { ...common, clientUserId: 'synthetic-client-user', triggeredBy: 'SYNC' };
}

describe('Pluggy webhook payload schemas', () => {
  it('validates every first-wave lifecycle and transaction event', () => {
    for (const event of supportedPluggyWebhookEvents) {
      expect(pluggyWebhookPayloadSchema.safeParse(fixture(event)).success, event).toBe(true);
    }
  });

  it('allows documented additive fields without trusting payment event types', () => {
    expect(
      pluggyWebhookPayloadSchema.parse({ ...fixture('item/updated'), additiveProviderField: true }),
    ).toHaveProperty('additiveProviderField', true);
    expect(
      pluggyWebhookPayloadSchema.safeParse({
        event: 'payment_intent/created',
        eventId: ids.event,
        itemId: ids.item,
        paymentIntentId: ids.transaction,
      }).success,
    ).toBe(false);
  });

  it('requires a documented created-transactions link and consistent transaction counts', () => {
    const created = fixture('transactions/created');
    delete created['createdTransactionsLinkV2'];
    expect(pluggyWebhookPayloadSchema.safeParse(created).success).toBe(false);

    const missingTimestamp = fixture('transactions/created');
    delete missingTimestamp['transactionsCreatedAtFrom'];
    expect(pluggyWebhookPayloadSchema.safeParse(missingTimestamp).success).toBe(false);

    expect(
      pluggyWebhookPayloadSchema.safeParse({
        ...fixture('transactions/updated'),
        transactionsCount: 2,
      }).success,
    ).toBe(false);
  });
});
