import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import {
  createWebhookDatabasePool,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
} from '@cashcount/db/webhook';
import { AccountCardRepository } from '@cashcount/db/finance';
import { describe, expect, it } from 'vitest';

import { createApiServer } from './api-server.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_account_card_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected account/card database identifier.');
  }
  return `"${identifier}"`;
}

describe('account/card API integration', () => {
  it('returns exact normalized evidence and rejects cross-workspace or cross-role access', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_account_card_${randomUUID().replaceAll('-', '')}`;
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${databaseName}`;
    const admin = createWebhookDatabasePool(databaseUrl);

    try {
      await admin.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(testUrl.toString());
      await seedSyntheticIdentity(testUrl.toString(), 'test');
      const client = createWebhookDatabasePool(testUrl.toString());
      client.on('error', () => undefined);
      try {
        const workspaceId = syntheticIdentitySeed.workspace.id;
        const otherWorkspaceId = '10000000-0000-4000-8000-000000000062';
        const connectionId = '20000000-0000-4000-8000-000000000061';
        const otherConnectionId = '20000000-0000-4000-8000-000000000062';
        const checkingId = '30000000-0000-4000-8000-000000000061';
        const cardId = '40000000-0000-4000-8000-000000000061';
        const otherCardId = '40000000-0000-4000-8000-000000000062';
        const billId = '50000000-0000-4000-8000-000000000061';
        const paymentId = '60000000-0000-4000-8000-000000000061';
        const chargeId = '70000000-0000-4000-8000-000000000061';
        await client.query(
          `insert into workspace (id, name) values ($1, 'Other Account API Workspace')`,
          [otherWorkspaceId],
        );
        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name,
             last_successful_sync_at
           ) values
             ($1, $3, 'PLUGGY', 'account-api-item', 'synthetic', 'Synthetic API Bank', $5),
             ($2, $4, 'PLUGGY', 'other-account-api-item', 'synthetic', 'Other API Bank', $5)`,
          [
            connectionId,
            otherConnectionId,
            workspaceId,
            otherWorkspaceId,
            new Date('2026-08-24T12:00:00Z'),
          ],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id, account_type,
             name, institution_name, currency, masked_number, current_balance, available_balance,
             credit_limit, available_credit_limit, closing_day, due_day, last_successful_sync_at,
             provider_history_earliest_date, provider_history_latest_date, history_coverage_status
           ) values
             ($1, $4, $6, 'PLUGGY', 'checking-private-id', 'CHECKING', 'Synthetic Checking',
              'Synthetic API Bank', 'BRL', '1234', 1000.123456, 900.123456, null, null, null, null,
              $8, '2026-01-01', '2026-08-24', 'PARTIAL'),
             ($2, $4, $6, 'PLUGGY', 'card-private-id', 'CREDIT_CARD', 'Synthetic Card',
              'Synthetic API Bank', 'BRL', '9876', -3000.000001, null, 10000.000001, 7000.000000,
              20, 28, $8, '2026-02-01', '2026-08-24', 'PROVIDER_MAXIMUM_RETRIEVED'),
             ($3, $5, $7, 'PLUGGY', 'other-private-id', 'CREDIT_CARD', 'Other Card',
              'Other API Bank', 'BRL', '1111', -1.000001, null, 2.000001, 1.000000,
              10, 18, $8, null, null, 'UNKNOWN')`,
          [
            checkingId,
            cardId,
            otherCardId,
            workspaceId,
            otherWorkspaceId,
            connectionId,
            otherConnectionId,
            new Date('2026-08-24T12:00:00Z'),
          ],
        );
        await client.query(
          `insert into credit_card_bill (
             id, workspace_id, financial_account_id, provider, external_bill_id, status,
             due_date, close_date, total_amount, minimum_payment, currency, allows_installments
           ) values ($1, $2, $3, 'PLUGGY', 'bill-private-id', 'OPEN', '2026-08-28',
                     '2026-08-20', 1000.000001, 100.000001, 'BRL', true)`,
          [billId, workspaceId, cardId],
        );
        await client.query(
          `insert into credit_card_bill_payment (
             id, workspace_id, credit_card_bill_id, provider, external_payment_id, value_type,
             payment_date, payment_mode, amount, currency
           ) values ($1, $2, $3, 'PLUGGY', 'payment-private-id', 'FULL_PAYMENT',
                     '2026-08-27', 'PIX', 1000.000001, 'BRL')`,
          [paymentId, workspaceId, billId],
        );
        await client.query(
          `insert into credit_card_bill_finance_charge (
             id, workspace_id, credit_card_bill_id, provider, external_charge_id, charge_type,
             amount, currency, additional_info
           ) values ($1, $2, $3, 'PLUGGY', 'charge-private-id', 'IOF', 10.000001, 'BRL', null)`,
          [chargeId, workspaceId, billId],
        );

        const webToken = 'synthetic-web-token-account-card-boundary-0000000000001';
        const mcpToken = 'synthetic-mcp-token-account-card-boundary-0000000000001';
        const server = createApiServer({
          accountCards: {
            repository: new AccountCardRepository(client),
            webToken,
            workspaceId,
          },
          inbox: {
            ingestAuthenticatedPluggyWebhook: async () => {
              throw new Error('Webhook must not be invoked by account/card reads.');
            },
          },
          mcpToken,
          nodeEnvironment: 'test',
          webhookSecret: 'synthetic-webhook-token-account-card-boundary-0000001',
          workspaceId,
        });
        try {
          const get = (path: string, token = webToken) =>
            server.inject({
              headers: { authorization: `Bearer ${token}` },
              method: 'GET',
              url: path,
            });
          const accounts = await get('/v1/accounts');
          expect(accounts.statusCode).toBe(200);
          expect(accounts.json()).toMatchObject({
            data: {
              items: [
                {
                  currentBalance: { currency: 'BRL', value: '1000.123456' },
                  id: checkingId,
                },
                {
                  currentBalance: { currency: 'BRL', value: '-3000.000001' },
                  id: cardId,
                },
              ],
            },
            meta: { workspaceId },
          });
          expect(accounts.body).not.toMatch(/private-id|"(?:external|provider|raw)[^"]*"\s*:/iu);

          const cards = await get('/v1/cards');
          expect(cards.json()).toMatchObject({
            data: {
              items: [
                {
                  availableCreditLimit: { currency: 'BRL', value: '7000.000000' },
                  creditLimit: { currency: 'BRL', value: '10000.000001' },
                  id: cardId,
                },
              ],
            },
          });
          expect((await get(`/v1/accounts/${otherCardId}`)).statusCode).toBe(404);
          expect((await get('/v1/accounts', mcpToken)).statusCode).toBe(401);

          const bills = await get(`/v1/cards/${cardId}/bills`);
          expect(bills.json()).toMatchObject({
            data: {
              items: [
                {
                  id: billId,
                  minimumPayment: { currency: 'BRL', value: '100.000001' },
                  totalAmount: { currency: 'BRL', value: '1000.000001' },
                },
              ],
            },
          });
          const payment = await get(`/v1/card-bills/${billId}/payments`);
          expect(payment.json()).toMatchObject({
            data: { items: [{ amount: { currency: 'BRL', value: '1000.000001' }, id: paymentId }] },
          });
          const charge = await get(`/v1/card-bills/${billId}/finance-charges`);
          expect(charge.json()).toMatchObject({
            data: { items: [{ amount: { currency: 'BRL', value: '10.000001' }, id: chargeId }] },
          });
        } finally {
          await server.close();
        }
      } finally {
        await client.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)}`);
      await admin.end();
    }
  }, 30_000);
});
