import { createHash, randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  FinancialRoleDetectionInvariantError,
  FinancialRoleDetectionRepository,
} from './financial-role-detection-repository.js';
import { runMigrations } from './migrations.js';
import { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_roles_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected role test database identifier.');
  }
  return `"${identifier}"`;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface TransactionFixture {
  accountId: string;
  amount: string;
  date?: string;
  description: string;
  direction: 'INFLOW' | 'OUTFLOW';
  id: string;
  merchantId?: string;
  role?: string;
  workspaceId: string;
}

describe('PostgreSQL financial-role detection repository', () => {
  it('detects normalized bill payments, unique transfers, and refunds without crossing safety boundaries', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_roles_${randomUUID().replaceAll('-', '')}`;
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: databaseUrl });

    try {
      await admin.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(testUrl.toString());
      await seedSyntheticIdentity(testUrl.toString(), 'test');
      const pool = new Pool({ connectionString: testUrl.toString() });
      pool.on('error', () => undefined);

      try {
        const repository = new FinancialRoleDetectionRepository(pool);
        const workspaceA = syntheticIdentitySeed.workspace.id;
        const workspaceB = '20000000-0000-4000-8000-000000000055';
        const connectionA = '30000000-0000-4000-8000-000000000055';
        const connectionB = '30000000-0000-4000-8000-000000000056';
        const checkingA = '40000000-0000-4000-8000-000000000055';
        const savingsA = '40000000-0000-4000-8000-000000000056';
        const checkingAlternativeA = '40000000-0000-4000-8000-000000000057';
        const cardA = '40000000-0000-4000-8000-000000000058';
        const checkingB = '40000000-0000-4000-8000-000000000059';
        const merchantA = '50000000-0000-4000-8000-000000000055';
        const transferOut = '60000000-0000-4000-8000-000000000055';
        const transferIn = '60000000-0000-4000-8000-000000000056';
        const crossWorkspaceTransfer = '60000000-0000-4000-8000-000000000057';
        const ambiguousOut = '60000000-0000-4000-8000-000000000058';
        const ambiguousInA = '60000000-0000-4000-8000-000000000059';
        const ambiguousInB = '60000000-0000-4000-8000-000000000060';
        const purchase = '60000000-0000-4000-8000-000000000061';
        const refund = '60000000-0000-4000-8000-000000000062';
        const signOnlyCredit = '60000000-0000-4000-8000-000000000063';
        const occupiedOut = '60000000-0000-4000-8000-000000000064';
        const occupiedIn = '60000000-0000-4000-8000-000000000065';
        const proposedForOccupied = '60000000-0000-4000-8000-000000000066';
        const bankBillPayment = '60000000-0000-4000-8000-000000000067';
        const cardBillPayment = '60000000-0000-4000-8000-000000000068';
        const billId = '70000000-0000-4000-8000-000000000055';
        const paymentId = '80000000-0000-4000-8000-000000000055';

        await pool.query(`insert into workspace (id, name) values ($1, 'Role Workspace B')`, [
          workspaceB,
        ]);
        await pool.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values
             ($1, $3, 'PLUGGY', 'role-connection-a', 'connector-a', 'Role Bank A'),
             ($2, $4, 'PLUGGY', 'role-connection-b', 'connector-b', 'Role Bank B')`,
          [connectionA, connectionB, workspaceA, workspaceB],
        );
        await pool.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency
           ) values
             ($1, $6, $8, 'PLUGGY', 'role-checking-a', 'CHECKING',
              'Checking A', 'Role Bank A', 'BRL'),
             ($2, $6, $8, 'PLUGGY', 'role-savings-a', 'SAVINGS',
              'Savings A', 'Role Bank A', 'BRL'),
             ($3, $6, $8, 'PLUGGY', 'role-alternative-a', 'CHECKING',
              'Alternative A', 'Role Bank A', 'BRL'),
             ($4, $6, $8, 'PLUGGY', 'role-card-a', 'CREDIT_CARD',
              'Card A', 'Role Bank A', 'BRL'),
             ($5, $7, $9, 'PLUGGY', 'role-checking-b', 'CHECKING',
              'Checking B', 'Role Bank B', 'BRL')`,
          [
            checkingA,
            savingsA,
            checkingAlternativeA,
            cardA,
            checkingB,
            workspaceA,
            workspaceB,
            connectionA,
            connectionB,
          ],
        );
        await pool.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key, review_status)
           values ($1, $2, 'Padaria Central', 'padaria central', 'CONFIRMED')`,
          [merchantA, workspaceA],
        );

        const insertTransaction = async (fixture: TransactionFixture): Promise<void> => {
          await pool.query(
            `insert into financial_transaction (
               id, workspace_id, financial_account_id, provider, provider_transaction_id,
               status, provider_type, provider_amount_signed, provider_currency,
               account_currency_amount_signed, account_currency, system_direction,
               system_financial_role, system_financial_role_source, provider_transaction_at,
               transaction_local_date, description_original, description_normalized,
               system_merchant_id, dedupe_fingerprint
             ) values (
               $1, $2, $3, 'PLUGGY', $4, 'POSTED', $5, $6, 'BRL', $6, 'BRL', $7,
               $8, case when $8 = 'UNKNOWN' then 'NONE' else 'HEURISTIC' end,
               ($9::date + time '12:00') at time zone 'UTC', $9, $10, $10, $11, $12
             )`,
            [
              fixture.id,
              fixture.workspaceId,
              fixture.accountId,
              `role-${fixture.id}`,
              fixture.direction === 'OUTFLOW' ? 'DEBIT' : 'CREDIT',
              fixture.amount,
              fixture.direction,
              fixture.role ?? 'UNKNOWN',
              fixture.date ?? '2026-08-24',
              fixture.description,
              fixture.merchantId ?? null,
              fingerprint(`${fixture.workspaceId}:${fixture.id}`),
            ],
          );
        };

        for (const fixture of [
          {
            accountId: checkingA,
            amount: '-100.000000',
            description: 'pix transferencia propria',
            direction: 'OUTFLOW',
            id: transferOut,
            workspaceId: workspaceA,
          },
          {
            accountId: savingsA,
            amount: '100.000000',
            description: 'pix recebido transferencia propria',
            direction: 'INFLOW',
            id: transferIn,
            workspaceId: workspaceA,
          },
          {
            accountId: checkingB,
            amount: '100.000000',
            description: 'pix recebido transferencia propria',
            direction: 'INFLOW',
            id: crossWorkspaceTransfer,
            workspaceId: workspaceB,
          },
          {
            accountId: checkingA,
            amount: '-70.000000',
            description: 'ted transferencia propria',
            direction: 'OUTFLOW',
            id: ambiguousOut,
            workspaceId: workspaceA,
          },
          {
            accountId: savingsA,
            amount: '70.000000',
            description: 'ted transferencia propria',
            direction: 'INFLOW',
            id: ambiguousInA,
            workspaceId: workspaceA,
          },
          {
            accountId: checkingAlternativeA,
            amount: '70.000000',
            description: 'ted transferencia propria',
            direction: 'INFLOW',
            id: ambiguousInB,
            workspaceId: workspaceA,
          },
          {
            accountId: cardA,
            amount: '-50.000000',
            date: '2026-08-20',
            description: 'padaria central',
            direction: 'OUTFLOW',
            id: purchase,
            merchantId: merchantA,
            workspaceId: workspaceA,
          },
          {
            accountId: cardA,
            amount: '50.000000',
            description: 'estorno padaria central',
            direction: 'INFLOW',
            id: refund,
            merchantId: merchantA,
            workspaceId: workspaceA,
          },
          {
            accountId: cardA,
            amount: '30.000000',
            description: 'credito recebido',
            direction: 'INFLOW',
            id: signOnlyCredit,
            role: 'UNKNOWN_CREDIT',
            workspaceId: workspaceA,
          },
          {
            accountId: checkingA,
            amount: '-40.000000',
            description: 'doc transferencia propria',
            direction: 'OUTFLOW',
            id: occupiedOut,
            role: 'TRANSFER',
            workspaceId: workspaceA,
          },
          {
            accountId: savingsA,
            amount: '40.000000',
            description: 'doc transferencia propria',
            direction: 'INFLOW',
            id: occupiedIn,
            role: 'TRANSFER',
            workspaceId: workspaceA,
          },
          {
            accountId: checkingAlternativeA,
            amount: '-40.000000',
            description: 'doc transferencia propria',
            direction: 'OUTFLOW',
            id: proposedForOccupied,
            workspaceId: workspaceA,
          },
          {
            accountId: checkingA,
            amount: '-500.000000',
            description: 'pagamento fatura cartao',
            direction: 'OUTFLOW',
            id: bankBillPayment,
            role: 'CARD_BILL_PAYMENT',
            workspaceId: workspaceA,
          },
          {
            accountId: cardA,
            amount: '500.000000',
            description: 'pagamento recebido',
            direction: 'INFLOW',
            id: cardBillPayment,
            workspaceId: workspaceA,
          },
        ] satisfies TransactionFixture[]) {
          await insertTransaction(fixture);
        }

        await pool.query(
          `update financial_transaction
           set transfer_pair_id = case id when $1 then $2::uuid else $1::uuid end
           where workspace_id = $3 and id in ($1, $2)`,
          [occupiedOut, occupiedIn, workspaceA],
        );
        await pool.query(
          `insert into transaction_user_state (
             financial_transaction_id, workspace_id, financial_role_override_enabled,
             financial_role_override, review_status, updated_by_actor_type
           ) values
             ($1, $3, false, null, 'NEEDS_REVIEW', 'USER'),
             ($2, $3, true, 'PURCHASE', 'UNREVIEWED', 'USER')`,
          [transferOut, purchase, workspaceA],
        );
        await pool.query(
          `insert into credit_card_bill (
             id, workspace_id, financial_account_id, provider, external_bill_id,
             status, total_amount, currency
           ) values ($1, $2, $3, 'PLUGGY', 'role-bill', 'CLOSED', '500.000000', 'BRL')`,
          [billId, workspaceA, cardA],
        );
        await pool.query(
          `insert into credit_card_bill_payment (
             id, workspace_id, credit_card_bill_id, provider, external_payment_id,
             value_type, payment_date, amount, currency, matched_card_transaction_id
           ) values ($1, $2, $3, 'PLUGGY', 'role-payment', 'PAID',
                     '2026-08-24', '500.000000', 'BRL', $4)`,
          [paymentId, workspaceA, billId, cardBillPayment],
        );
        await pool.query(
          `insert into bill_payment_reconciliation (
             workspace_id, credit_card_bill_payment_id, financial_transaction_id,
             match_status, match_method, confidence, matched_at
           ) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
          [workspaceA, paymentId, bankBillPayment],
        );

        await expect(repository.detect(workspaceB, transferOut)).rejects.toBeInstanceOf(
          FinancialRoleDetectionInvariantError,
        );

        await expect(repository.detect(workspaceA, cardBillPayment)).resolves.toMatchObject({
          affectedTransactionIds: [cardBillPayment],
          kind: 'BILL_PAYMENT',
          status: 'APPLIED',
        });
        const billEffects = await pool.query<{
          cashflow_effect_amount: string;
          id: string;
          spend_effect_amount: string;
        }>(
          `select s.id, s.spend_effect_amount, c.cashflow_effect_amount
           from v_transaction_spend_effect s
           join v_transaction_cashflow_effect c using (workspace_id, id)
           where s.workspace_id = $1 and s.id in ($2, $3)
           order by s.id`,
          [workspaceA, bankBillPayment, cardBillPayment],
        );
        expect(Object.fromEntries(billEffects.rows.map((row) => [row.id, row]))).toMatchObject({
          [bankBillPayment]: {
            cashflow_effect_amount: '-500.000000',
            spend_effect_amount: '0.000000',
          },
          [cardBillPayment]: {
            cashflow_effect_amount: '0.000000',
            spend_effect_amount: '0.000000',
          },
        });

        await expect(repository.detect(workspaceA, transferOut)).resolves.toMatchObject({
          affectedTransactionIds: [transferOut, transferIn],
          candidateTransactionIds: [transferIn],
          kind: 'TRANSFER',
          status: 'APPLIED',
        });
        await expect(repository.detect(workspaceA, transferOut)).resolves.toMatchObject({
          candidateTransactionIds: [transferIn],
          kind: 'TRANSFER',
          status: 'ALREADY_APPLIED',
        });
        expect(
          await pool.query(
            `select id, transfer_pair_id, system_financial_role
             from financial_transaction where workspace_id = $1 and id in ($2, $3)
             order by id`,
            [workspaceA, transferOut, transferIn],
          ),
        ).toMatchObject({
          rows: [
            { id: transferOut, system_financial_role: 'TRANSFER', transfer_pair_id: transferIn },
            { id: transferIn, system_financial_role: 'TRANSFER', transfer_pair_id: transferOut },
          ],
        });
        expect(
          await pool.query(
            `select review_status, version from transaction_user_state
             where workspace_id = $1 and financial_transaction_id = $2`,
            [workspaceA, transferOut],
          ),
        ).toMatchObject({ rows: [{ review_status: 'NEEDS_REVIEW', version: 1 }] });

        await expect(repository.detect(workspaceA, ambiguousOut)).resolves.toMatchObject({
          candidateTransactionIds: [ambiguousInA, ambiguousInB],
          kind: 'TRANSFER',
          status: 'NEEDS_REVIEW',
        });
        expect(
          await pool.query(
            `select system_financial_role, transfer_pair_id from financial_transaction
             where workspace_id = $1 and id = $2`,
            [workspaceA, ambiguousOut],
          ),
        ).toMatchObject({
          rows: [{ system_financial_role: 'UNKNOWN', transfer_pair_id: null }],
        });

        await expect(repository.detect(workspaceA, proposedForOccupied)).resolves.toMatchObject({
          kind: null,
          status: 'NO_MATCH',
        });
        expect(
          await pool.query(
            `select transfer_pair_id from financial_transaction
             where workspace_id = $1 and id = $2`,
            [workspaceA, proposedForOccupied],
          ),
        ).toMatchObject({ rows: [{ transfer_pair_id: null }] });

        await expect(repository.detect(workspaceA, refund)).resolves.toMatchObject({
          affectedTransactionIds: [refund],
          candidateTransactionIds: [purchase],
          kind: 'REFUND',
          status: 'APPLIED',
        });
        await expect(repository.detect(workspaceA, signOnlyCredit)).resolves.toMatchObject({
          kind: null,
          status: 'NO_MATCH',
        });
        expect(
          await pool.query(
            `select system_financial_role from financial_transaction
             where workspace_id = $1 and id in ($2, $3) order by id`,
            [workspaceA, refund, signOnlyCredit],
          ),
        ).toMatchObject({
          rows: [{ system_financial_role: 'REFUND' }, { system_financial_role: 'UNKNOWN_CREDIT' }],
        });

        const decisions = await pool.query<{
          financial_transaction_id: string;
          selected: boolean;
          source: string;
        }>(
          `select financial_transaction_id, selected, source from classification_decision
           where workspace_id = $1 order by financial_transaction_id`,
          [workspaceA],
        );
        expect(decisions.rows).toEqual(
          expect.arrayContaining([
            { financial_transaction_id: ambiguousOut, selected: false, source: 'HEURISTIC' },
            { financial_transaction_id: cardBillPayment, selected: true, source: 'HEURISTIC' },
            { financial_transaction_id: refund, selected: true, source: 'HEURISTIC' },
            { financial_transaction_id: transferOut, selected: true, source: 'HEURISTIC' },
          ]),
        );
        expect(
          await pool.query<{ count: number }>(
            `select count(*)::integer as count from classification_decision
             where workspace_id = $1 and financial_transaction_id = $2`,
            [workspaceA, transferOut],
          ),
        ).toMatchObject({ rows: [{ count: 1 }] });
        expect(
          await pool.query<{ count: number }>(
            `select count(*)::integer as count from transaction_revision
             where workspace_id = $1 and change_type = 'CLASSIFICATION'`,
            [workspaceA],
          ),
        ).toMatchObject({ rows: [{ count: 4 }] });
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)} with (force)`);
      await admin.end();
    }
  }, 30_000);
});
