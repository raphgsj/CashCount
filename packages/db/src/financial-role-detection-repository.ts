import type { Pool, PoolClient } from 'pg';

import {
  detectBillPaymentRole,
  detectInternalTransfer,
  detectRefund,
  financialRoleDetectionPolicyVersion,
  type AccountType,
  type FinancialRoleDetectionFacts,
  type PairDetectionResult,
  type TransactionDirection,
} from '@cashcount/domain';

import { canonicalJsonSha256 } from './encryption.js';

export type FinancialRoleDetectionKind = 'BILL_PAYMENT' | 'REFUND' | 'TRANSFER';
export type FinancialRoleDetectionStatus =
  'ALREADY_APPLIED' | 'APPLIED' | 'NEEDS_REVIEW' | 'NO_MATCH' | 'TOLERANCE_REQUIRED';

export interface FinancialRoleDetectionResult {
  affectedTransactionIds: readonly string[];
  candidateTransactionIds: readonly string[];
  kind: FinancialRoleDetectionKind | null;
  policyVersion: typeof financialRoleDetectionPolicyVersion;
  status: FinancialRoleDetectionStatus;
}

interface TransactionRow {
  account_id: string;
  account_type: AccountType;
  amount_signed: string | null;
  currency: string;
  description_normalized: string;
  direction: TransactionDirection;
  effective_financial_role: string;
  id: string;
  merchant_id: string | null;
  system_financial_role: string;
  transaction_local_date: string;
  transfer_pair_id: string | null;
}

interface BillEvidenceRow {
  bank_transaction_id: string | null;
  card_transaction_id: string | null;
  payment_id: string;
  reconciliation_id: string | null;
}

export class FinancialRoleDetectionInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FinancialRoleDetectionInvariantError';
  }
}

function requireText(name: string, value: string): string {
  if (value.trim() !== value || value.length === 0 || value.length > 100) {
    throw new TypeError(`${name} must contain 1 to 100 trimmed characters.`);
  }
  return value;
}

function facts(row: TransactionRow): FinancialRoleDetectionFacts | null {
  if (row.amount_signed === null) return null;
  return {
    accountId: row.account_id,
    accountType: row.account_type,
    amountSigned: row.amount_signed,
    currency: row.currency,
    descriptionNormalized: row.description_normalized,
    direction: row.direction,
    id: row.id,
    merchantId: row.merchant_id,
    transactionLocalDate: row.transaction_local_date,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original failure when PostgreSQL already aborted the transaction.
  }
}

function result(
  status: FinancialRoleDetectionStatus,
  kind: FinancialRoleDetectionKind | null,
  candidates: readonly string[] = [],
  affected: readonly string[] = [],
): FinancialRoleDetectionResult {
  return {
    affectedTransactionIds: affected,
    candidateTransactionIds: candidates,
    kind,
    policyVersion: financialRoleDetectionPolicyVersion,
    status,
  };
}

async function loadTransaction(
  client: PoolClient,
  workspaceId: string,
  transactionId: string,
): Promise<TransactionRow | null> {
  const selected = await client.query<TransactionRow>(
    `select ft.id, ft.financial_account_id as account_id, fa.account_type,
            coalesce(ft.account_currency_amount_signed,
              case when ft.provider_currency = ft.account_currency then ft.provider_amount_signed end
            )::text as amount_signed,
            ft.account_currency as currency, ft.description_normalized,
            ft.system_direction as direction, ft.system_merchant_id as merchant_id,
            ft.transaction_local_date::text, ft.system_financial_role,
            effective.effective_financial_role, ft.transfer_pair_id
     from financial_transaction ft
     join financial_account fa
       on fa.workspace_id = ft.workspace_id and fa.id = ft.financial_account_id
     join v_financial_transaction_effective effective
       on effective.workspace_id = ft.workspace_id and effective.id = ft.id
     where ft.workspace_id = $1 and ft.id = $2 and ft.deleted_at is null
     for update of ft`,
    [workspaceId, transactionId],
  );
  return selected.rows[0] ?? null;
}

async function loadCandidates(
  client: PoolClient,
  workspaceId: string,
  target: TransactionRow,
): Promise<TransactionRow[]> {
  const candidates = await client.query<TransactionRow>(
    `select ft.id, ft.financial_account_id as account_id, fa.account_type,
            coalesce(ft.account_currency_amount_signed,
              case when ft.provider_currency = ft.account_currency then ft.provider_amount_signed end
            )::text as amount_signed,
            ft.account_currency as currency, ft.description_normalized,
            ft.system_direction as direction, ft.system_merchant_id as merchant_id,
            ft.transaction_local_date::text, ft.system_financial_role,
            effective.effective_financial_role, ft.transfer_pair_id
     from financial_transaction ft
     join financial_account fa
       on fa.workspace_id = ft.workspace_id and fa.id = ft.financial_account_id
     join v_financial_transaction_effective effective
       on effective.workspace_id = ft.workspace_id and effective.id = ft.id
     where ft.workspace_id = $1 and ft.id <> $2 and ft.deleted_at is null
       and ft.transaction_local_date between $3::date - 120 and $3::date + 2
     order by ft.transaction_local_date desc, ft.id
     limit 501`,
    [workspaceId, target.id, target.transaction_local_date],
  );
  if (candidates.rows.length > 500) {
    throw new FinancialRoleDetectionInvariantError('Financial-role candidate bound was exceeded.');
  }
  return candidates.rows;
}

async function loadBillEvidence(
  client: PoolClient,
  workspaceId: string,
  transactionId: string,
): Promise<BillEvidenceRow[]> {
  const evidence = await client.query<BillEvidenceRow>(
    `select p.id as payment_id, p.matched_card_transaction_id as card_transaction_id,
            r.id as reconciliation_id, r.financial_transaction_id as bank_transaction_id
     from credit_card_bill_payment p
     left join bill_payment_reconciliation r
       on r.workspace_id = p.workspace_id and r.credit_card_bill_payment_id = p.id
      and r.match_status in ('AUTO_MATCHED', 'USER_CONFIRMED')
     where p.workspace_id = $1
       and (p.matched_card_transaction_id = $2 or r.financial_transaction_id = $2)
     order by p.id`,
    [workspaceId, transactionId],
  );
  return evidence.rows;
}

async function persistDecision(
  client: PoolClient,
  workspaceId: string,
  transactionId: string,
  kind: FinancialRoleDetectionKind,
  role: 'CARD_BILL_PAYMENT' | 'REFUND' | 'TRANSFER',
  selected: boolean,
  confidence: string | null,
  fingerprint: string,
  candidateIds: readonly string[],
): Promise<void> {
  const boundedCandidates = candidateIds.slice(0, 10).join(',');
  await client.query(
    `insert into classification_decision (
       workspace_id, financial_transaction_id, source, source_reference, financial_role,
       confidence, input_fingerprint, rationale, selected
     ) values ($1, $2, 'HEURISTIC', $3, $4, $5, $6, $7, $8)
     on conflict (workspace_id, financial_transaction_id, source, source_reference,
                  input_fingerprint) do nothing`,
    [
      workspaceId,
      transactionId,
      `${financialRoleDetectionPolicyVersion}:${kind}`,
      role,
      confidence,
      fingerprint,
      `status=${selected ? 'AUTO_CONFIRMED' : 'NEEDS_REVIEW'};candidateCount=${candidateIds.length};candidates=${boundedCandidates}`,
      selected,
    ],
  );
}

async function applyRole(
  client: PoolClient,
  workspaceId: string,
  transactionIds: readonly string[],
  role: 'CARD_BILL_PAYMENT' | 'REFUND' | 'TRANSFER',
  transferPairs: ReadonlyMap<string, string> = new Map(),
): Promise<string[]> {
  const changed: string[] = [];
  for (const transactionId of transactionIds) {
    const update = await client.query<{ id: string }>(
      `update financial_transaction
       set system_financial_role = $3,
           system_financial_role_source = 'HEURISTIC',
           system_financial_role_confidence = '0.9900',
           transfer_pair_id = coalesce($4::uuid, transfer_pair_id),
           updated_at = now()
       where workspace_id = $1 and id = $2
         and (system_financial_role is distinct from $3
              or system_financial_role_source is distinct from 'HEURISTIC'
              or ($4::uuid is not null and transfer_pair_id is distinct from $4::uuid))
       returning id`,
      [workspaceId, transactionId, role, transferPairs.get(transactionId) ?? null],
    );
    if (update.rows[0] !== undefined) changed.push(transactionId);
  }
  for (const transactionId of changed) {
    await client.query(
      `insert into transaction_revision (
         workspace_id, financial_transaction_id, change_type, changed_fields, actor_type, actor_id
       ) values ($1, $2, 'CLASSIFICATION',
                 jsonb_build_object('financialRole', $3::text,
                                    'policyVersion', $4::text),
                 'SYSTEM', $4)`,
      [workspaceId, transactionId, role, financialRoleDetectionPolicyVersion],
    );
  }
  return changed;
}

function fingerprint(
  kind: FinancialRoleDetectionKind,
  target: FinancialRoleDetectionFacts,
  candidateIds: readonly string[],
  evidenceReference: string | null = null,
): string {
  return canonicalJsonSha256({
    candidateIds: [...candidateIds].sort(),
    evidenceReference,
    kind,
    policyVersion: financialRoleDetectionPolicyVersion,
    target,
  });
}

export class FinancialRoleDetectionRepository {
  public constructor(private readonly pool: Pool) {}

  public async detect(
    workspaceId: string,
    transactionId: string,
  ): Promise<FinancialRoleDetectionResult> {
    requireText('workspaceId', workspaceId);
    requireText('transactionId', transactionId);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `financial-role-detection:${workspaceId}`,
      ]);
      const targetRow = await loadTransaction(client, workspaceId, transactionId);
      if (targetRow === null) {
        throw new FinancialRoleDetectionInvariantError(
          'Transaction was not found in the required workspace.',
        );
      }
      const target = facts(targetRow);
      if (target === null) {
        await client.query('commit');
        return result('NO_MATCH', null);
      }

      const billEvidence = await loadBillEvidence(client, workspaceId, transactionId);
      if (billEvidence.length > 1) {
        const candidates = billEvidence.map(({ payment_id }) => payment_id);
        await persistDecision(
          client,
          workspaceId,
          transactionId,
          'BILL_PAYMENT',
          'CARD_BILL_PAYMENT',
          false,
          null,
          fingerprint('BILL_PAYMENT', target, candidates),
          candidates,
        );
        await client.query('commit');
        return result('NEEDS_REVIEW', 'BILL_PAYMENT', candidates);
      }
      const bill = billEvidence[0];
      if (bill !== undefined) {
        const detected = detectBillPaymentRole(target, {
          activeBankReconciliationId: bill.reconciliation_id,
          matchedCardPaymentChildId:
            bill.card_transaction_id === transactionId ? bill.payment_id : null,
        });
        if (detected.status === 'CONFIRMED') {
          const affected = [bill.card_transaction_id, bill.bank_transaction_id].filter(
            (id): id is string => id !== null,
          );
          const decisionFingerprint = fingerprint(
            'BILL_PAYMENT',
            target,
            affected,
            detected.evidenceReference,
          );
          await persistDecision(
            client,
            workspaceId,
            transactionId,
            'BILL_PAYMENT',
            'CARD_BILL_PAYMENT',
            true,
            '0.9900',
            decisionFingerprint,
            affected,
          );
          const changed = await applyRole(client, workspaceId, affected, 'CARD_BILL_PAYMENT');
          await client.query('commit');
          return result(
            changed.length === 0 ? 'ALREADY_APPLIED' : 'APPLIED',
            'BILL_PAYMENT',
            affected,
            changed,
          );
        }
      }

      if (targetRow.transfer_pair_id !== null) {
        await client.query('commit');
        return result('ALREADY_APPLIED', 'TRANSFER', [targetRow.transfer_pair_id]);
      }
      if (targetRow.effective_financial_role === 'REFUND') {
        await client.query('commit');
        return result('ALREADY_APPLIED', 'REFUND');
      }
      if (targetRow.effective_financial_role === 'CARD_BILL_PAYMENT') {
        await client.query('commit');
        return result('ALREADY_APPLIED', 'BILL_PAYMENT');
      }

      const tolerance = await client.query<{ tolerance_amount: string }>(
        `select tolerance_amount::text from reconciliation_currency_tolerance where currency = $1`,
        [target.currency],
      );
      const toleranceAmount = tolerance.rows[0]?.tolerance_amount;
      if (toleranceAmount === undefined) {
        await client.query('commit');
        return result('TOLERANCE_REQUIRED', null);
      }
      const candidateRows = await loadCandidates(client, workspaceId, targetRow);
      const transferCandidateRows = candidateRows.filter(
        (candidate) =>
          candidate.transfer_pair_id === null &&
          candidate.effective_financial_role !== 'CARD_BILL_PAYMENT' &&
          candidate.effective_financial_role !== 'REFUND',
      );
      const transferCandidateFacts = transferCandidateRows
        .map(facts)
        .filter((item): item is FinancialRoleDetectionFacts => item !== null);
      const transfer = detectInternalTransfer(target, transferCandidateFacts, toleranceAmount);
      if (transfer.status !== 'NONE') {
        const transferResult = await this.persistPairDetection(
          client,
          workspaceId,
          target,
          transferCandidateFacts,
          transfer,
          toleranceAmount,
          'TRANSFER',
        );
        await client.query('commit');
        return transferResult;
      }

      const candidateFacts = candidateRows
        .map(facts)
        .filter((item): item is FinancialRoleDetectionFacts => item !== null);
      const purchases = candidateFacts.filter((candidate) => {
        const row = candidateRows.find(({ id }) => id === candidate.id);
        return row?.effective_financial_role === 'PURCHASE';
      });
      const refund = detectRefund(target, purchases, toleranceAmount);
      if (refund.status !== 'NONE') {
        const ids = refund.candidates.map(({ candidateId }) => candidateId);
        const decisionFingerprint = fingerprint('REFUND', target, ids);
        await persistDecision(
          client,
          workspaceId,
          transactionId,
          'REFUND',
          'REFUND',
          refund.status === 'AUTO_CONFIRMED',
          refund.status === 'AUTO_CONFIRMED' ? '0.9900' : null,
          decisionFingerprint,
          ids,
        );
        if (refund.status === 'NEEDS_REVIEW') {
          await client.query('commit');
          return result('NEEDS_REVIEW', 'REFUND', ids);
        }
        const changed = await applyRole(client, workspaceId, [transactionId], 'REFUND');
        await client.query('commit');
        return result(changed.length === 0 ? 'ALREADY_APPLIED' : 'APPLIED', 'REFUND', ids, changed);
      }

      await client.query('commit');
      return result('NO_MATCH', null);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistPairDetection(
    client: PoolClient,
    workspaceId: string,
    target: FinancialRoleDetectionFacts,
    candidates: readonly FinancialRoleDetectionFacts[],
    detection: PairDetectionResult,
    toleranceAmount: string,
    kind: 'TRANSFER',
  ): Promise<FinancialRoleDetectionResult> {
    const ids = detection.candidates.map(({ candidateId }) => candidateId);
    let autoConfirmed = detection.status === 'AUTO_CONFIRMED';
    const counterpartId = detection.matchedTransactionId;
    if (autoConfirmed && counterpartId !== null) {
      const counterpart = candidates.find(({ id }) => id === counterpartId);
      if (counterpart === undefined) autoConfirmed = false;
      else {
        const reciprocal = detectInternalTransfer(
          counterpart,
          [target, ...candidates.filter(({ id }) => id !== counterpart.id)],
          toleranceAmount,
        );
        autoConfirmed =
          reciprocal.status === 'AUTO_CONFIRMED' && reciprocal.matchedTransactionId === target.id;
      }
    }
    const decisionFingerprint = fingerprint(kind, target, ids);
    await persistDecision(
      client,
      workspaceId,
      target.id,
      kind,
      'TRANSFER',
      autoConfirmed,
      autoConfirmed ? '0.9900' : null,
      decisionFingerprint,
      ids,
    );
    if (!autoConfirmed || counterpartId === null) {
      return result('NEEDS_REVIEW', kind, ids);
    }
    const pairs = new Map([
      [target.id, counterpartId],
      [counterpartId, target.id],
    ]);
    const changed = await applyRole(
      client,
      workspaceId,
      [target.id, counterpartId],
      'TRANSFER',
      pairs,
    );
    return result(changed.length === 0 ? 'ALREADY_APPLIED' : 'APPLIED', kind, ids, changed);
  }
}
