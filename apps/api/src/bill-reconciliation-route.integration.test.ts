import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { BillReconciliationRepository } from '@cashcount/db/finance';
import {
  createWebhookDatabasePool,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
} from '@cashcount/db/webhook';
import { describe, expect, it } from 'vitest';

import { createApiServer } from './api-server.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_bill_reconciliation_api_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected bill reconciliation database identifier.');
  }
  return `"${identifier}"`;
}

describe('bill reconciliation API integration', () => {
  it('generates bounded candidates and audits isolated confirm/reject count-once workflows', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_bill_reconciliation_api_${randomUUID().replaceAll('-', '')}`;
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
        const connectionId = '21000000-0000-4000-8000-000000000066';
        const cardId = '31000000-0000-4000-8000-000000000066';
        const checkingId = '31000000-0000-4000-8000-000000000067';
        const billId = '41000000-0000-4000-8000-000000000066';
        const paymentId = '51000000-0000-4000-8000-000000000066';
        const purchaseId = '61000000-0000-4000-8000-000000000066';
        const pendingId = '61000000-0000-4000-8000-000000000067';
        const exactCandidateId = '61000000-0000-4000-8000-000000000068';
        const nearCandidateId = '61000000-0000-4000-8000-000000000069';

        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id,
             display_name, local_status, last_successful_sync_at
           ) values ($1, $2, 'PLUGGY', 'bill-reconciliation-private-item', 'synthetic',
             'Synthetic Bank', 'ACTIVE', '2026-08-27T00:00:00Z')`,
          [connectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency, masked_number,
             last_successful_sync_at
           ) values
             ($1, $3, $4, 'PLUGGY', 'bill-card-private', 'CREDIT_CARD',
               'Synthetic Card', 'Synthetic Bank', 'BRL', '4444', '2026-08-27T00:00:00Z'),
             ($2, $3, $4, 'PLUGGY', 'bill-checking-private', 'CHECKING',
               'Synthetic Checking', 'Synthetic Bank', 'BRL', '1111', '2026-08-27T00:00:00Z')`,
          [cardId, checkingId, workspaceId, connectionId],
        );
        await client.query(
          `insert into credit_card_bill (
             id, workspace_id, financial_account_id, provider, external_bill_id, status,
             due_date, close_date, total_amount, currency
           ) values ($1, $2, $3, 'PLUGGY', 'bill-private', 'OPEN',
             '2026-08-25', '2026-08-20', 100.000000, 'BRL')`,
          [billId, workspaceId, cardId],
        );
        await client.query(
          `insert into credit_card_bill_payment (
             id, workspace_id, credit_card_bill_id, provider, external_payment_id,
             value_type, payment_date, amount, currency
           ) values ($1, $2, $3, 'PLUGGY', 'payment-private', 'FULL_PAYMENT',
             '2026-08-25', 100.000000, 'BRL')`,
          [paymentId, workspaceId, billId],
        );

        const insertTransaction = (input: {
          accountId: string;
          amount: string;
          billId?: string;
          date: string;
          description: string;
          direction: 'OUTFLOW';
          id: string;
          role: 'CARD_BILL_PAYMENT' | 'PURCHASE';
          status?: 'PENDING' | 'POSTED';
        }) =>
          client.query(
            `insert into financial_transaction (
               id, workspace_id, financial_account_id, provider, provider_transaction_id,
               status, provider_type, provider_amount_signed, provider_currency,
               account_currency_amount_signed, account_currency, system_direction,
               system_financial_role, provider_transaction_at, transaction_local_date,
               description_original, description_normalized, system_financial_role_source,
               system_exclusion_source, credit_card_bill_id, dedupe_fingerprint
             ) values ($1, $2, $3, 'PLUGGY', $4, $5, 'DEBIT', $6, 'BRL', $6, 'BRL',
               $7, $8, ($9::date + time '12:00') at time zone 'UTC', $9, $10, lower($10),
               'HEURISTIC', 'POLICY', $11, repeat(md5($4), 2))`,
            [
              input.id,
              workspaceId,
              input.accountId,
              `private-${input.id}`,
              input.status ?? 'POSTED',
              input.amount,
              input.direction,
              input.role,
              input.date,
              input.description,
              input.billId ?? null,
            ],
          );

        await insertTransaction({
          accountId: cardId,
          amount: '90.000000',
          billId,
          date: '2026-08-10',
          description: 'Posted purchase',
          direction: 'OUTFLOW',
          id: purchaseId,
          role: 'PURCHASE',
        });
        await insertTransaction({
          accountId: cardId,
          amount: '10.000000',
          billId,
          date: '2026-08-19',
          description: 'Pending purchase',
          direction: 'OUTFLOW',
          id: pendingId,
          role: 'PURCHASE',
          status: 'PENDING',
        });
        await insertTransaction({
          accountId: checkingId,
          amount: '-100.000000',
          date: '2026-08-25',
          description: 'Pagamento CPF 12345678901',
          direction: 'OUTFLOW',
          id: exactCandidateId,
          role: 'CARD_BILL_PAYMENT',
        });
        await insertTransaction({
          accountId: checkingId,
          amount: '-100.005000',
          date: '2026-08-26',
          description: 'Possible card payment',
          direction: 'OUTFLOW',
          id: nearCandidateId,
          role: 'CARD_BILL_PAYMENT',
        });

        const webToken = 'synthetic-web-token-bill-reconciliation-000000000001';
        const mcpToken = 'synthetic-mcp-token-bill-reconciliation-000000000001';
        const webhookToken = 'synthetic-webhook-bill-reconciliation-00000000001';
        const repository = new BillReconciliationRepository(client);
        const server = createApiServer({
          billReconciliation: { mcpToken, repository, webToken, workspaceId },
          inbox: {
            ingestAuthenticatedPluggyWebhook: async () => {
              throw new Error('Webhook must not run during bill reconciliation.');
            },
          },
          mcpToken,
          nodeEnvironment: 'test',
          webhookSecret: webhookToken,
          workspaceId,
        });
        try {
          const inject = async (input: {
            body?: Record<string, string>;
            path: string;
            token?: string;
          }) => {
            const options = {
              headers: { authorization: `Bearer ${input.token ?? webToken}` },
              method:
                input.path.includes('/reconciliation-candidates') ||
                input.path.includes('/confirm-') ||
                input.path.includes('/reject-')
                  ? ('POST' as const)
                  : ('GET' as const),
              url: input.path,
            };
            return input.body === undefined
              ? server.inject(options)
              : server.inject({ ...options, payload: input.body });
          };

          const initial = await inject({
            path: `/v1/card-bills/${billId}/reconciliation`,
            token: mcpToken,
          });
          expect(initial.statusCode).toBe(200);
          expect(initial.json()).toMatchObject({
            data: {
              linkedTransactionTotal: { value: '100.000000' },
              normalizedPaymentTotal: { value: '100.000000' },
              pendingPurchaseTotal: { value: '10.000000' },
              postedNetSpendingTotal: { value: '90.000000' },
              reconciliationStatus: 'NEEDS_REVIEW',
              unresolvedItemCount: 1,
            },
            meta: { policyVersion: 1, workspaceId },
          });
          expect(initial.body).not.toMatch(/private|4444|1111/iu);

          const generated = await inject({
            body: {},
            path: `/v1/bill-payments/${paymentId}/reconciliation-candidates`,
          });
          expect(generated.statusCode).toBe(200);
          expect(generated.json().data.items).toHaveLength(2);
          expect(generated.body).not.toContain('12345678901');
          const exact = generated
            .json()
            .data.items.find(
              (item: { transactionId: string }) => item.transactionId === exactCandidateId,
            );
          const near = generated
            .json()
            .data.items.find(
              (item: { transactionId: string }) => item.transactionId === nearCandidateId,
            );
          expect(exact).toMatchObject({ confidence: '1.0000', matchStatus: 'CANDIDATE' });
          expect(near).toMatchObject({ confidence: '0.9500', matchStatus: 'CANDIDATE' });

          const rejected = await inject({
            body: { actorId: 'synthetic-owner', candidateId: near.id },
            path: `/v1/bill-payments/${paymentId}/reject-reconciliation`,
          });
          expect(rejected.statusCode).toBe(200);
          expect(rejected.json().data.matchStatus).toBe('REJECTED');

          const confirmed = await inject({
            body: { actorId: 'synthetic-owner', candidateId: exact.id },
            path: `/v1/bill-payments/${paymentId}/confirm-reconciliation`,
          });
          expect(confirmed.statusCode).toBe(200);
          expect(confirmed.json().data.matchStatus).toBe('USER_CONFIRMED');
          expect(
            (
              await inject({
                body: { actorId: 'synthetic-owner', candidateId: exact.id },
                path: `/v1/bill-payments/${paymentId}/confirm-reconciliation`,
              })
            ).statusCode,
          ).toBe(200);

          const reconciled = await inject({ path: `/v1/card-bills/${billId}/reconciliation` });
          expect(reconciled.statusCode).toBe(200);
          expect(reconciled.json()).toMatchObject({
            data: {
              confirmedBankPaymentCount: 1,
              confirmedBankPaymentTotal: { value: '100.000000' },
              reconciliationStatus: 'RECONCILED',
              unresolvedItemCount: 0,
            },
            warnings: [],
          });
          expect(
            Number(
              (
                await client.query(
                  `select count(*)::integer as count from audit_event
                   where workspace_id = $1 and event_type like 'BILL_PAYMENT_RECONCILIATION_%'`,
                  [workspaceId],
                )
              ).rows[0]?.count,
            ),
          ).toBe(2);

          expect(
            (
              await inject({
                body: { actorId: 'synthetic-owner', candidateId: exact.id },
                path: `/v1/bill-payments/${paymentId}/reject-reconciliation`,
                token: mcpToken,
              })
            ).statusCode,
          ).toBe(401);
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
  }, 45_000);
});
