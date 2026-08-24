import type { Pool, PoolClient } from 'pg';

import {
  scoreTransactionReplacement,
  transactionReplacementAutoConfirmThreshold,
  transactionReplacementPolicyVersion,
  type ReplacementTransactionFacts,
} from '@cashcount/domain';

export type TransactionReplacementStatus =
  'AUTO_CONFIRMED' | 'NEEDS_REVIEW' | 'REJECTED' | 'USER_CONFIRMED';

export interface TransactionReplacementDetectionResult {
  autoConfirmed: number;
  candidatesInserted: number;
  candidatesSeen: number;
  needsReview: number;
  stateTransfersCompleted: number;
}

export interface TransactionReplacementTransferResult {
  alreadyTransferred: boolean;
  fieldsTransferred: string[];
  tagsTransferred: number;
}

interface SyncWindowRow {
  finished_at: Date | null;
  started_at: Date;
  status: string;
}

interface ReplacementRow {
  account_id: string;
  bill_forecast_month: Date | null | string;
  card_last_four: string | null;
  description_normalized: string;
  id: string;
  installment_number: number | null;
  installment_total: number | null;
  payee_mcc: string | null;
  provider_amount_signed: string;
  provider_bill_id: string | null;
  provider_currency: string;
  provider_type: string | null;
  transaction_local_date: Date | string;
}

interface LinkRow {
  id: string;
  predecessor_transaction_id: string;
  status: TransactionReplacementStatus;
  successor_transaction_id: string;
}

interface UserStateRow {
  category_id_override: string | null;
  category_override_enabled: boolean;
  excluded_from_spend_override: boolean | null;
  financial_role_override: string | null;
  financial_role_override_enabled: boolean;
  financial_transaction_id: string;
  merchant_id_override: string | null;
  merchant_override_enabled: boolean;
  notes: string | null;
  review_status: string;
}

export class TransactionReplacementInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TransactionReplacementInvariantError';
  }
}

export class TransactionReplacementTransferConflictError extends Error {
  public constructor() {
    super('Replacement successor already has user-owned state or tags.');
    this.name = 'TransactionReplacementTransferConflictError';
  }
}

function databaseDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function facts(row: ReplacementRow): ReplacementTransactionFacts {
  return {
    accountId: row.account_id,
    amountSigned: row.provider_amount_signed,
    billForecastMonth:
      row.bill_forecast_month === null ? null : databaseDate(row.bill_forecast_month).slice(0, 7),
    cardLastFour: row.card_last_four,
    currency: row.provider_currency,
    descriptionNormalized: row.description_normalized,
    installmentNumber: row.installment_number,
    installmentTotal: row.installment_total,
    localDate: databaseDate(row.transaction_local_date),
    payeeMcc: row.payee_mcc,
    providerBillId: row.provider_bill_id,
    providerType: row.provider_type,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original error when PostgreSQL has already aborted the connection.
  }
}

export class TransactionReplacementRepository {
  public constructor(private readonly pool: Pool) {}

  public async detectForSync(
    workspaceId: string,
    syncRunId: string,
    detectedAt = new Date(),
  ): Promise<TransactionReplacementDetectionResult> {
    const client = await this.pool.connect();
    const autoLinkIds: string[] = [];
    let candidatesInserted = 0;
    let candidatesSeen = 0;
    let needsReview = 0;

    try {
      await client.query('begin');
      const runResult = await client.query<SyncWindowRow>(
        `select started_at, finished_at, status
         from sync_run
         where workspace_id = $1 and id = $2
         for share`,
        [workspaceId, syncRunId],
      );
      const run = runResult.rows[0];
      if (run === undefined || run.status !== 'SUCCEEDED' || run.finished_at === null) {
        throw new TransactionReplacementInvariantError(
          'Replacement detection requires a completed workspace-scoped sync run.',
        );
      }
      const columns = `ft.id, ft.financial_account_id as account_id,
        ft.provider_amount_signed, ft.provider_currency,
        ft.transaction_local_date, ft.description_normalized, ft.provider_type,
        ft.installment_number, ft.installment_total, ft.bill_forecast_month,
        ft.provider_bill_id, ft.card_last_four, ft.payee_mcc`;
      const parameters = [workspaceId, syncRunId, run.started_at, run.finished_at];
      const predecessors = await client.query<ReplacementRow>(
        `select ${columns}
         from financial_transaction ft
         join financial_account fa
           on fa.workspace_id = ft.workspace_id and fa.id = ft.financial_account_id
         join sync_run sr
           on sr.workspace_id = ft.workspace_id and sr.provider_connection_id = fa.provider_connection_id
         where ft.workspace_id = $1 and sr.id = $2 and ft.status = 'DELETED'
           and ft.deleted_at >= $3 and ft.deleted_at <= $4
         order by ft.id
         for share of ft`,
        parameters,
      );
      const successors = await client.query<ReplacementRow>(
        `select ${columns}
         from financial_transaction ft
         join financial_account fa
           on fa.workspace_id = ft.workspace_id and fa.id = ft.financial_account_id
         join sync_run sr
           on sr.workspace_id = ft.workspace_id and sr.provider_connection_id = fa.provider_connection_id
         where ft.workspace_id = $1 and sr.id = $2 and ft.status <> 'DELETED'
           and ft.created_at >= $3 and ft.created_at <= $4
         order by ft.id
         for share of ft`,
        parameters,
      );
      const eligible = predecessors.rows.flatMap((predecessor) =>
        successors.rows.flatMap((successor) => {
          const score = scoreTransactionReplacement(facts(predecessor), facts(successor));
          return score.eligible ? [{ predecessor, score, successor }] : [];
        }),
      );
      const predecessorCandidates = new Map<string, number>();
      const successorCandidates = new Map<string, number>();
      for (const candidate of eligible) {
        predecessorCandidates.set(
          candidate.predecessor.id,
          (predecessorCandidates.get(candidate.predecessor.id) ?? 0) + 1,
        );
        successorCandidates.set(
          candidate.successor.id,
          (successorCandidates.get(candidate.successor.id) ?? 0) + 1,
        );
      }

      for (const candidate of eligible) {
        candidatesSeen += 1;
        const successorData = await client.query<{ present: boolean }>(
          `select exists (
             select 1 from transaction_user_state
             where workspace_id = $1 and financial_transaction_id = $2
             union all
             select 1 from transaction_tag
             where workspace_id = $1 and financial_transaction_id = $2
           ) as present`,
          [workspaceId, candidate.successor.id],
        );
        const successorUserDataPresent = successorData.rows[0]?.present ?? false;
        const unambiguous =
          predecessorCandidates.get(candidate.predecessor.id) === 1 &&
          successorCandidates.get(candidate.successor.id) === 1;
        const status: TransactionReplacementStatus =
          candidate.score.score >= transactionReplacementAutoConfirmThreshold &&
          unambiguous &&
          !successorUserDataPresent
            ? 'AUTO_CONFIRMED'
            : 'NEEDS_REVIEW';
        const evidence = {
          amountCompatible: true,
          dateDistanceDays: candidate.score.dateDistanceDays,
          descriptionSimilarity: candidate.score.descriptionSimilarity,
          policyVersion: candidate.score.policyVersion,
          predecessorCandidateCount: predecessorCandidates.get(candidate.predecessor.id) ?? 0,
          successorCandidateCount: successorCandidates.get(candidate.successor.id) ?? 0,
          successorUserDataPresent,
        };
        const inserted = await client.query<{
          id: string;
          inserted: boolean;
          status: TransactionReplacementStatus;
        }>(
          `insert into transaction_identity_link (
             workspace_id, predecessor_transaction_id, successor_transaction_id,
             link_type, status, confidence, evidence, detected_at, confirmed_at, confirmed_by
           ) values ($1, $2, $3, 'PROVIDER_REPLACEMENT', $4::text, $5::numeric,
             $6::jsonb, $7::timestamptz,
             case when $4::text = 'AUTO_CONFIRMED' then $7::timestamptz else null end,
             case when $4::text = 'AUTO_CONFIRMED' then 'replacement-policy' else null end)
           on conflict (workspace_id, predecessor_transaction_id, successor_transaction_id, link_type)
           do update set
             confidence = case
               when transaction_identity_link.status in ('AUTO_CONFIRMED', 'USER_CONFIRMED', 'REJECTED')
                 then transaction_identity_link.confidence
               else excluded.confidence
             end,
             evidence = case
               when transaction_identity_link.status in ('AUTO_CONFIRMED', 'USER_CONFIRMED', 'REJECTED')
                 then transaction_identity_link.evidence
               else excluded.evidence
             end,
             detected_at = case
               when transaction_identity_link.status in ('AUTO_CONFIRMED', 'USER_CONFIRMED', 'REJECTED')
                 then transaction_identity_link.detected_at
               else excluded.detected_at
             end,
             status = case
               when transaction_identity_link.status in ('AUTO_CONFIRMED', 'USER_CONFIRMED', 'REJECTED')
                 then transaction_identity_link.status
               else excluded.status
             end,
             confirmed_at = case
               when transaction_identity_link.status in ('AUTO_CONFIRMED', 'USER_CONFIRMED', 'REJECTED')
                 then transaction_identity_link.confirmed_at
               else excluded.confirmed_at
             end,
             confirmed_by = case
               when transaction_identity_link.status in ('AUTO_CONFIRMED', 'USER_CONFIRMED', 'REJECTED')
                 then transaction_identity_link.confirmed_by
               else excluded.confirmed_by
             end
           returning id, status, (xmax = 0) as inserted`,
          [
            workspaceId,
            candidate.predecessor.id,
            candidate.successor.id,
            status,
            candidate.score.score,
            evidence,
            detectedAt,
          ],
        );
        const link = inserted.rows[0];
        if (link === undefined) {
          throw new TransactionReplacementInvariantError('Replacement candidate upsert failed.');
        }
        if (link.inserted) candidatesInserted += 1;
        if (link.status === 'AUTO_CONFIRMED') autoLinkIds.push(link.id);
        if (link.status === 'NEEDS_REVIEW') needsReview += 1;
      }
      await client.query('commit');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }

    let autoConfirmed = autoLinkIds.length;
    let stateTransfersCompleted = 0;
    for (const linkId of autoLinkIds) {
      try {
        const transfer = await this.transferConfirmed(workspaceId, linkId, 'WORKER', null);
        if (!transfer.alreadyTransferred) stateTransfersCompleted += 1;
      } catch (error) {
        if (!(error instanceof TransactionReplacementTransferConflictError)) throw error;
        await this.pool.query(
          `update transaction_identity_link
           set status = 'NEEDS_REVIEW', confirmed_at = null, confirmed_by = null
           where workspace_id = $1 and id = $2 and status = 'AUTO_CONFIRMED'`,
          [workspaceId, linkId],
        );
        autoConfirmed -= 1;
        needsReview += 1;
      }
    }
    return {
      autoConfirmed,
      candidatesInserted,
      candidatesSeen,
      needsReview,
      stateTransfersCompleted,
    };
  }

  public async reviewCandidate(
    workspaceId: string,
    linkId: string,
    decision: 'CONFIRM' | 'REJECT',
    actorId: string,
    decidedAt = new Date(),
  ): Promise<TransactionReplacementTransferResult | null> {
    if (decision === 'CONFIRM') {
      return this.transferConfirmed(workspaceId, linkId, 'USER', actorId, decidedAt, true);
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const linkResult = await client.query<LinkRow>(
        `select id, predecessor_transaction_id, successor_transaction_id, status
         from transaction_identity_link where workspace_id = $1 and id = $2 for update`,
        [workspaceId, linkId],
      );
      const link = linkResult.rows[0];
      if (link === undefined) {
        throw new TransactionReplacementInvariantError('Replacement candidate was not found.');
      }
      if (link.status === 'AUTO_CONFIRMED' || link.status === 'USER_CONFIRMED') {
        throw new TransactionReplacementInvariantError(
          'A confirmed replacement cannot be rejected without an explicit undo operation.',
        );
      }
      if (link.status !== 'REJECTED') {
        await client.query(
          `update transaction_identity_link
           set status = 'REJECTED', confirmed_at = null, confirmed_by = $3
           where workspace_id = $1 and id = $2`,
          [workspaceId, linkId, actorId],
        );
        await client.query(
          `insert into audit_event (
             workspace_id, actor_type, actor_id, event_type, target_type, target_id, details, created_at
           ) values ($1, 'USER', $2, 'TRANSACTION_REPLACEMENT_REJECTED',
             'transaction_identity_link', $3, $4, $5)`,
          [
            workspaceId,
            actorId,
            linkId,
            {
              policyVersion: transactionReplacementPolicyVersion,
              predecessorTransactionId: link.predecessor_transaction_id,
              successorTransactionId: link.successor_transaction_id,
            },
            decidedAt,
          ],
        );
      }
      await client.query('commit');
      return null;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async transferConfirmed(
    workspaceId: string,
    linkId: string,
    actorType: 'USER' | 'WORKER',
    actorId: null | string,
    transferredAt = new Date(),
    userConfirmation = false,
  ): Promise<TransactionReplacementTransferResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const linkResult = await client.query<LinkRow>(
        `select id, predecessor_transaction_id, successor_transaction_id, status
         from transaction_identity_link where workspace_id = $1 and id = $2 for update`,
        [workspaceId, linkId],
      );
      const link = linkResult.rows[0];
      if (link === undefined || link.status === 'REJECTED') {
        throw new TransactionReplacementInvariantError(
          'A confirmed replacement candidate is required for transfer.',
        );
      }
      const priorAudit = await client.query<{ id: string }>(
        `select id from audit_event
         where workspace_id = $1 and event_type = 'TRANSACTION_REPLACEMENT_STATE_TRANSFERRED'
           and target_type = 'transaction_identity_link' and target_id = $2
         limit 1`,
        [workspaceId, linkId],
      );
      if (priorAudit.rows.length > 0) {
        await client.query('commit');
        return { alreadyTransferred: true, fieldsTransferred: [], tagsTransferred: 0 };
      }
      if (!userConfirmation && link.status !== 'AUTO_CONFIRMED') {
        throw new TransactionReplacementInvariantError(
          'Automatic transfer requires an auto-confirmed replacement.',
        );
      }
      await client.query(
        `select id from financial_transaction
         where workspace_id = $1 and id in ($2, $3)
         order by id for update`,
        [workspaceId, link.predecessor_transaction_id, link.successor_transaction_id],
      );
      const states = await client.query<UserStateRow>(
        `select * from transaction_user_state
         where workspace_id = $1 and financial_transaction_id in ($2, $3)
         order by financial_transaction_id for update`,
        [workspaceId, link.predecessor_transaction_id, link.successor_transaction_id],
      );
      const predecessorState = states.rows.find(
        (row) => row.financial_transaction_id === link.predecessor_transaction_id,
      );
      const successorState = states.rows.find(
        (row) => row.financial_transaction_id === link.successor_transaction_id,
      );
      const tags = await client.query<{ financial_transaction_id: string; tag_id: string }>(
        `select financial_transaction_id, tag_id from transaction_tag
         where workspace_id = $1 and financial_transaction_id in ($2, $3)
         order by financial_transaction_id, tag_id for update`,
        [workspaceId, link.predecessor_transaction_id, link.successor_transaction_id],
      );
      const predecessorTags = tags.rows.filter(
        (row) => row.financial_transaction_id === link.predecessor_transaction_id,
      );
      const successorTags = tags.rows.filter(
        (row) => row.financial_transaction_id === link.successor_transaction_id,
      );
      if (successorState !== undefined || successorTags.length > 0) {
        throw new TransactionReplacementTransferConflictError();
      }
      if (userConfirmation) {
        await client.query(
          `update transaction_identity_link
           set status = 'USER_CONFIRMED', confirmed_at = $3, confirmed_by = $4
           where workspace_id = $1 and id = $2`,
          [workspaceId, linkId, transferredAt, actorId],
        );
      }

      const fieldsTransferred =
        predecessorState === undefined
          ? []
          : [
              'categoryOverride',
              'merchantOverride',
              'financialRoleOverride',
              'excludedFromSpendOverride',
              'notes',
              'reviewStatus',
            ];
      if (predecessorState !== undefined) {
        await client.query(
          `insert into transaction_user_state (
             financial_transaction_id, workspace_id, category_override_enabled,
             category_id_override, merchant_override_enabled, merchant_id_override,
             financial_role_override_enabled, financial_role_override,
             excluded_from_spend_override, notes, review_status, version,
             updated_by_actor_type, updated_by_actor_id, created_at, updated_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1,
             $12, $13, $14, $14)`,
          [
            link.successor_transaction_id,
            workspaceId,
            predecessorState.category_override_enabled,
            predecessorState.category_id_override,
            predecessorState.merchant_override_enabled,
            predecessorState.merchant_id_override,
            predecessorState.financial_role_override_enabled,
            predecessorState.financial_role_override,
            predecessorState.excluded_from_spend_override,
            predecessorState.notes,
            predecessorState.review_status,
            actorType === 'USER' ? 'USER' : 'SYSTEM',
            actorId,
            transferredAt,
          ],
        );
      }
      for (const tagRow of predecessorTags) {
        await client.query(
          `insert into transaction_tag (
             workspace_id, financial_transaction_id, tag_id, created_at
           ) values ($1, $2, $3, $4)`,
          [workspaceId, link.successor_transaction_id, tagRow.tag_id, transferredAt],
        );
      }
      const details = {
        fieldsTransferred,
        policyVersion: transactionReplacementPolicyVersion,
        predecessorTransactionId: link.predecessor_transaction_id,
        successorTransactionId: link.successor_transaction_id,
        tagIds: predecessorTags.map((row) => row.tag_id),
      };
      await client.query(
        `insert into transaction_revision (
           workspace_id, financial_transaction_id, change_type, changed_fields,
           actor_type, actor_id, created_at
         ) values ($1, $2, 'MERGE', $3, $4, $5, $6)`,
        [
          workspaceId,
          link.successor_transaction_id,
          details,
          actorType === 'USER' ? 'USER' : 'SYSTEM',
          actorId,
          transferredAt,
        ],
      );
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id,
           details, created_at
         ) values ($1, $2, $3, 'TRANSACTION_REPLACEMENT_STATE_TRANSFERRED',
           'transaction_identity_link', $4, $5, $6)`,
        [workspaceId, actorType, actorId, linkId, details, transferredAt],
      );
      await client.query('commit');
      return {
        alreadyTransferred: false,
        fieldsTransferred,
        tagsTransferred: predecessorTags.length,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
