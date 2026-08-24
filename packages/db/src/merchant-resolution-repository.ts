import type { Pool, PoolClient } from 'pg';

import {
  merchantCandidateSimilarity,
  merchantFuzzyReviewThreshold,
  merchantPatternAutoMatchThreshold,
  merchantResolutionPolicyVersion,
  normalizeTransactionDescription,
} from '@cashcount/classification';

export type MerchantReviewStatus = 'AUTO' | 'CONFIRMED' | 'NEEDS_REVIEW';
export type MerchantResolutionMethod =
  'EXACT_ALIAS' | 'EXACT_KEY' | 'PATTERN_ALIAS' | 'PROVIDER_IDENTITY' | 'PROVISIONAL';
export type MerchantReviewReason = 'AMBIGUOUS_PATTERN_ALIAS' | 'FUZZY_TEXT';

export interface MerchantRecord {
  canonicalName: string;
  cnpjHash: string | null;
  id: string;
  mcc: string | null;
  normalizedKey: string;
  reviewStatus: MerchantReviewStatus;
  workspaceId: string;
}

export interface MerchantReviewCandidate {
  canonicalName: string;
  merchantId: string;
  reason: MerchantReviewReason;
  similarity: string;
}

export interface MerchantResolutionResult {
  matchedAliasId: string | null;
  merchant: MerchantRecord;
  method: MerchantResolutionMethod;
  policyVersion: typeof merchantResolutionPolicyVersion;
  reviewCandidates: readonly MerchantReviewCandidate[];
}

export interface ResolveMerchantInput {
  descriptionNormalized: string;
  mcc?: string | null;
  providerBusinessName?: string | null;
  providerIdentityHash?: string | null;
  providerMerchantName?: string | null;
}

export interface CreateCanonicalMerchantInput {
  actorId: string;
  canonicalName: string;
  cnpjHash?: string | null;
  mcc?: string | null;
}

export interface ConfirmMerchantAliasInput {
  actorId: string;
  alias: string;
  matchType: 'CONTAINS' | 'EXACT' | 'PREFIX';
  merchantId: string;
}

interface MerchantRow {
  canonical_name: string;
  cnpj_hash: string | null;
  id: string;
  mcc: string | null;
  normalized_key: string;
  review_status: MerchantReviewStatus;
  workspace_id: string;
}

interface AliasMatchRow extends MerchantRow {
  alias_id: string;
  confidence: string;
}

interface FuzzyMerchantRow extends MerchantRow {
  aliases: string[];
}

export class MerchantResolutionInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MerchantResolutionInvariantError';
  }
}

export class MerchantAliasConflictError extends Error {
  public constructor() {
    super('The normalized alias is already assigned to another workspace merchant.');
    this.name = 'MerchantAliasConflictError';
  }
}

function requireText(name: string, value: string, maximum: number): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new TypeError(`${name} must contain 1 to ${maximum} trimmed characters.`);
  }
  return value;
}

function requireMcc(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!/^\d{4}$/u.test(value)) throw new TypeError('mcc must contain exactly four digits.');
  return value;
}

function optionalText(
  name: string,
  value: string | null | undefined,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  return requireText(name, value, maximum);
}

function requireHash(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('providerIdentityHash must be a lowercase SHA-256 hexadecimal value.');
  }
  return value;
}

function normalizedKey(name: string, value: string): string {
  const normalized = normalizeTransactionDescription(value).normalized;
  if (normalized.length === 0 || normalized.length > 1_000) {
    throw new TypeError(
      `${name} must produce a non-empty normalized key of at most 1000 characters.`,
    );
  }
  return normalized;
}

function merchant(row: MerchantRow): MerchantRecord {
  return {
    canonicalName: row.canonical_name,
    cnpjHash: row.cnpj_hash,
    id: row.id,
    mcc: row.mcc,
    normalizedKey: row.normalized_key,
    reviewStatus: row.review_status,
    workspaceId: row.workspace_id,
  };
}

function result(
  row: MerchantRow,
  method: MerchantResolutionMethod,
  matchedAliasId: string | null = null,
  reviewCandidates: readonly MerchantReviewCandidate[] = [],
): MerchantResolutionResult {
  return {
    matchedAliasId,
    merchant: merchant(row),
    method,
    policyVersion: merchantResolutionPolicyVersion,
    reviewCandidates,
  };
}

async function requireWorkspace(client: PoolClient, workspaceId: string): Promise<void> {
  const workspace = await client.query(`select 1 from workspace where id = $1`, [workspaceId]);
  if (workspace.rowCount !== 1) {
    throw new MerchantResolutionInvariantError('Merchant workspace was not found.');
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original failure when PostgreSQL already aborted the transaction.
  }
}

function uniqueKeys(input: ResolveMerchantInput): string[] {
  const values = [
    normalizedKey(
      'descriptionNormalized',
      requireText('descriptionNormalized', input.descriptionNormalized, 1_000),
    ),
    input.providerMerchantName === null || input.providerMerchantName === undefined
      ? null
      : normalizedKey(
          'providerMerchantName',
          requireText('providerMerchantName', input.providerMerchantName, 500),
        ),
    input.providerBusinessName === null || input.providerBusinessName === undefined
      ? null
      : normalizedKey(
          'providerBusinessName',
          requireText('providerBusinessName', input.providerBusinessName, 500),
        ),
  ].filter((value): value is string => value !== null);
  return [...new Set(values)];
}

function provisionalName(input: ResolveMerchantInput): string {
  return (
    optionalText('providerMerchantName', input.providerMerchantName, 500) ??
    optionalText('providerBusinessName', input.providerBusinessName, 500) ??
    requireText('descriptionNormalized', input.descriptionNormalized, 1_000)
  );
}

export class MerchantResolutionRepository {
  public constructor(private readonly pool: Pool) {}

  public async resolve(
    workspaceId: string,
    input: ResolveMerchantInput,
  ): Promise<MerchantResolutionResult> {
    requireText('workspaceId', workspaceId, 100);
    const keys = uniqueKeys(input);
    const identityHash = requireHash(input.providerIdentityHash);
    const mcc = requireMcc(input.mcc);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await requireWorkspace(client, workspaceId);

      for (const key of keys) {
        const exactAlias = await client.query<AliasMatchRow>(
          `select m.id, m.workspace_id, m.canonical_name, m.normalized_key, m.mcc,
                  m.cnpj_hash, m.review_status, ma.id as alias_id, ma.confidence
           from merchant_alias ma
           join merchant m on m.workspace_id = ma.workspace_id and m.id = ma.merchant_id
           where ma.workspace_id = $1 and ma.alias_normalized = $2
             and ma.is_active and ma.is_confirmed
           limit 1`,
          [workspaceId, key],
        );
        const alias = exactAlias.rows[0];
        if (alias !== undefined) {
          await client.query('commit');
          return result(alias, 'EXACT_ALIAS', alias.alias_id);
        }
      }

      for (const key of keys) {
        const exactKey = await client.query<MerchantRow>(
          `select id, workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status
           from merchant where workspace_id = $1 and normalized_key = $2 limit 1`,
          [workspaceId, key],
        );
        const row = exactKey.rows[0];
        if (row !== undefined) {
          await client.query('commit');
          return result(row, 'EXACT_KEY');
        }
      }

      if (identityHash !== null) {
        const identity = await client.query<MerchantRow>(
          `select id, workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status
           from merchant where workspace_id = $1 and cnpj_hash = $2 limit 1`,
          [workspaceId, identityHash],
        );
        const row = identity.rows[0];
        if (row !== undefined) {
          await client.query('commit');
          return result(row, 'PROVIDER_IDENTITY');
        }
      }

      const patternRows = await client.query<AliasMatchRow>(
        `select m.id, m.workspace_id, m.canonical_name, m.normalized_key, m.mcc,
                m.cnpj_hash, m.review_status, ma.id as alias_id, ma.confidence
         from merchant_alias ma
         join merchant m on m.workspace_id = ma.workspace_id and m.id = ma.merchant_id
         where ma.workspace_id = $1 and ma.is_active and ma.is_confirmed
           and ma.confidence >= $3::numeric
           and ma.match_type in ('PREFIX', 'CONTAINS')
           and exists (
             select 1 from unnest($2::text[]) candidate(value)
             where (ma.match_type = 'PREFIX' and position(ma.alias_normalized in candidate.value) = 1)
                or (ma.match_type = 'CONTAINS' and position(ma.alias_normalized in candidate.value) > 0)
           )
         order by ma.confidence desc, length(ma.alias_normalized) desc, ma.id
         limit 100`,
        [workspaceId, keys, merchantPatternAutoMatchThreshold],
      );
      const patternMerchants = new Map(patternRows.rows.map((row) => [row.id, row]));
      if (patternMerchants.size === 1) {
        const row = patternMerchants.values().next().value as AliasMatchRow;
        await client.query('commit');
        return result(row, 'PATTERN_ALIAS', row.alias_id);
      }

      const fuzzyRows = await client.query<FuzzyMerchantRow>(
        `select m.id, m.workspace_id, m.canonical_name, m.normalized_key, m.mcc,
                m.cnpj_hash, m.review_status,
                coalesce(array_agg(ma.alias_normalized order by ma.alias_normalized)
                  filter (where ma.id is not null and ma.is_active), '{}') as aliases
         from merchant m
         left join merchant_alias ma
           on ma.workspace_id = m.workspace_id and ma.merchant_id = m.id
         where m.workspace_id = $1
         group by m.id
         order by m.id
         limit 500`,
        [workspaceId],
      );
      const ambiguousPatternConfidence = new Map<string, string>();
      for (const row of patternRows.rows) {
        const current = ambiguousPatternConfidence.get(row.id);
        if (current === undefined || row.confidence > current) {
          ambiguousPatternConfidence.set(row.id, row.confidence);
        }
      }
      const reviewCandidates = fuzzyRows.rows
        .map((row): MerchantReviewCandidate | null => {
          const comparisonKeys = [row.normalized_key, ...row.aliases];
          const fuzzySimilarity = keys
            .flatMap((key) =>
              comparisonKeys.map((comparison) => merchantCandidateSimilarity(key, comparison)),
            )
            .sort()
            .at(-1);
          const patternConfidence = ambiguousPatternConfidence.get(row.id);
          const similarity =
            patternConfidence !== undefined &&
            (fuzzySimilarity === undefined || patternConfidence > fuzzySimilarity)
              ? patternConfidence
              : fuzzySimilarity;
          if (similarity === undefined || similarity < merchantFuzzyReviewThreshold) return null;
          return {
            canonicalName: row.canonical_name,
            merchantId: row.id,
            reason: patternConfidence === undefined ? 'FUZZY_TEXT' : 'AMBIGUOUS_PATTERN_ALIAS',
            similarity,
          };
        })
        .filter((candidate): candidate is MerchantReviewCandidate => candidate !== null)
        .sort((left, right) =>
          right.similarity === left.similarity
            ? left.merchantId.localeCompare(right.merchantId)
            : right.similarity.localeCompare(left.similarity),
        )
        .slice(0, 5);

      const canonicalName = provisionalName(input);
      const provisionalKey =
        input.providerMerchantName === null || input.providerMerchantName === undefined
          ? keys[0]
          : normalizedKey('providerMerchantName', input.providerMerchantName);
      if (provisionalKey === undefined) {
        throw new MerchantResolutionInvariantError('A provisional merchant key is required.');
      }
      const inserted = await client.query<MerchantRow>(
        `insert into merchant (
           workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status
         ) values ($1, $2, $3, $4, $5, 'NEEDS_REVIEW')
         on conflict do nothing
         returning id, workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status`,
        [workspaceId, canonicalName, provisionalKey, mcc, identityHash],
      );
      let row = inserted.rows[0];
      let method: MerchantResolutionMethod = 'PROVISIONAL';
      if (row === undefined) {
        const raced = await client.query<MerchantRow>(
          `select id, workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status
           from merchant
           where workspace_id = $1 and (normalized_key = $2 or ($3::char(64) is not null and cnpj_hash = $3))
           order by normalized_key = $2 desc
           limit 1`,
          [workspaceId, provisionalKey, identityHash],
        );
        row = raced.rows[0];
        method =
          row !== undefined && row.normalized_key !== provisionalKey
            ? 'PROVIDER_IDENTITY'
            : 'EXACT_KEY';
      }
      if (row === undefined) {
        throw new MerchantResolutionInvariantError('Concurrent provisional resolution failed.');
      }
      await client.query('commit');
      return result(row, method, null, reviewCandidates);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async createCanonicalMerchant(
    workspaceId: string,
    input: CreateCanonicalMerchantInput,
  ): Promise<MerchantRecord> {
    requireText('workspaceId', workspaceId, 100);
    const actorId = requireText('actorId', input.actorId, 200);
    const canonicalName = requireText('canonicalName', input.canonicalName, 500);
    const key = normalizedKey('canonicalName', canonicalName);
    const hash = requireHash(input.cnpjHash);
    const mcc = requireMcc(input.mcc);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await requireWorkspace(client, workspaceId);
      await client.query(
        `select pg_advisory_xact_lock(
           hashtextextended('cashcount:merchant-canonical:' || $1::text || ':' || $2::text, 0)
         )`,
        [workspaceId, key],
      );
      if (hash !== null) {
        await client.query(
          `select pg_advisory_xact_lock(
             hashtextextended('cashcount:merchant-identity:' || $1::text || ':' || $2::text, 0)
           )`,
          [workspaceId, hash],
        );
      }
      const existing = await client.query<MerchantRow>(
        `select id, workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status
         from merchant
         where workspace_id = $1 and (normalized_key = $2 or ($3::char(64) is not null and cnpj_hash = $3))
         order by normalized_key = $2 desc
         for update`,
        [workspaceId, key, hash],
      );
      if (new Set(existing.rows.map((row) => row.id)).size > 1) {
        throw new MerchantResolutionInvariantError(
          'Canonical name and identity hash refer to different merchants.',
        );
      }
      let row = existing.rows[0];
      let created = false;
      if (row === undefined) {
        const inserted = await client.query<MerchantRow>(
          `insert into merchant (
             workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status
           ) values ($1, $2, $3, $4, $5, 'CONFIRMED')
           returning id, workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status`,
          [workspaceId, canonicalName, key, mcc, hash],
        );
        row = inserted.rows[0];
        created = true;
      } else {
        const updated = await client.query<MerchantRow>(
          `update merchant
           set canonical_name = $3, normalized_key = $4,
               mcc = coalesce($5, mcc), cnpj_hash = coalesce($6, cnpj_hash),
               review_status = 'CONFIRMED', updated_at = now()
           where workspace_id = $1 and id = $2
           returning id, workspace_id, canonical_name, normalized_key, mcc, cnpj_hash, review_status`,
          [workspaceId, row.id, canonicalName, key, mcc, hash],
        );
        row = updated.rows[0];
      }
      if (row === undefined) {
        throw new MerchantResolutionInvariantError('Canonical merchant write failed.');
      }
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'MERCHANT_CANONICAL_CONFIRMED', 'MERCHANT', $3,
           jsonb_build_object('created', $4::boolean, 'policyVersion', $5::text))`,
        [workspaceId, actorId, row.id, created, merchantResolutionPolicyVersion],
      );
      await client.query('commit');
      return merchant(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async confirmAlias(
    workspaceId: string,
    input: ConfirmMerchantAliasInput,
  ): Promise<string> {
    requireText('workspaceId', workspaceId, 100);
    const actorId = requireText('actorId', input.actorId, 200);
    const alias = normalizedKey('alias', requireText('alias', input.alias, 1_000));
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await requireWorkspace(client, workspaceId);
      await client.query(
        `select pg_advisory_xact_lock(
           hashtextextended('cashcount:merchant-alias:' || $1::text || ':' || $2::text, 0)
         )`,
        [workspaceId, alias],
      );
      const target = await client.query(
        `select 1 from merchant where workspace_id = $1 and id = $2 for share`,
        [workspaceId, input.merchantId],
      );
      if (target.rowCount !== 1) {
        throw new MerchantResolutionInvariantError('Alias target merchant was not found.');
      }
      const existing = await client.query<{ id: string; merchant_id: string }>(
        `select id, merchant_id from merchant_alias
         where workspace_id = $1 and alias_normalized = $2
         for update`,
        [workspaceId, alias],
      );
      const current = existing.rows[0];
      if (current !== undefined && current.merchant_id !== input.merchantId) {
        throw new MerchantAliasConflictError();
      }
      const aliasResult = await client.query<{ id: string }>(
        `insert into merchant_alias (
           workspace_id, merchant_id, alias_normalized, match_type,
           source, confidence, is_active, is_confirmed
         ) values ($1, $2, $3, $4, 'USER', '1.0000', true, true)
         on conflict (workspace_id, alias_normalized) do update set
           match_type = excluded.match_type, source = 'USER', confidence = '1.0000',
           is_active = true, is_confirmed = true, updated_at = now()
         where merchant_alias.merchant_id = excluded.merchant_id
         returning id`,
        [workspaceId, input.merchantId, alias, input.matchType],
      );
      const aliasId = aliasResult.rows[0]?.id;
      if (aliasId === undefined) {
        throw new MerchantAliasConflictError();
      }
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'MERCHANT_ALIAS_CONFIRMED', 'MERCHANT_ALIAS', $3,
           jsonb_build_object('matchType', $4::text, 'merchantId', $5::uuid,
             'policyVersion', $6::text))`,
        [
          workspaceId,
          actorId,
          aliasId,
          input.matchType,
          input.merchantId,
          merchantResolutionPolicyVersion,
        ],
      );
      await client.query('commit');
      return aliasId;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
