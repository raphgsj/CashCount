import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  MerchantAliasConflictError,
  MerchantResolutionInvariantError,
  MerchantResolutionRepository,
} from './merchant-resolution-repository.js';
import { runMigrations } from './migrations.js';
import { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_merchant_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected merchant test database identifier.');
  }
  return `"${identifier}"`;
}

describe('PostgreSQL merchant resolution repository', () => {
  it('resolves confirmed evidence and keeps ambiguous/fuzzy candidates review-only by workspace', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_merchant_${randomUUID().replaceAll('-', '')}`;
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
        const repository = new MerchantResolutionRepository(pool);
        const workspaceA = syntheticIdentitySeed.workspace.id;
        const workspaceB = '20000000-0000-4000-8000-000000000052';
        const starbucksHash = 'a'.repeat(64);
        await pool.query(`insert into workspace (id, name) values ($1, 'Merchant Workspace B')`, [
          workspaceB,
        ]);

        const starbucksA = await repository.createCanonicalMerchant(workspaceA, {
          actorId: 'owner-a',
          canonicalName: 'Starbucks',
          cnpjHash: starbucksHash,
          mcc: '5814',
        });
        const starbucksB = await repository.createCanonicalMerchant(workspaceB, {
          actorId: 'owner-b',
          canonicalName: 'Starbucks',
          cnpjHash: starbucksHash,
        });
        expect(starbucksA).toMatchObject({
          normalizedKey: 'starbucks',
          reviewStatus: 'CONFIRMED',
          workspaceId: workspaceA,
        });
        expect(starbucksB.id).not.toBe(starbucksA.id);

        const exactAliasId = await repository.confirmAlias(workspaceA, {
          actorId: 'owner-a',
          alias: 'MP *STBKS BRASIL 00392',
          matchType: 'EXACT',
          merchantId: starbucksA.id,
        });
        await expect(
          repository.resolve(workspaceA, { descriptionNormalized: 'stbks brasil' }),
        ).resolves.toMatchObject({
          matchedAliasId: exactAliasId,
          merchant: { id: starbucksA.id },
          method: 'EXACT_ALIAS',
          reviewCandidates: [],
        });
        await expect(
          repository.resolve(workspaceA, {
            descriptionNormalized: 'unrelated provider purchase',
            providerMerchantName: 'Starbucks',
          }),
        ).resolves.toMatchObject({ merchant: { id: starbucksA.id }, method: 'EXACT_KEY' });
        await expect(
          repository.resolve(workspaceA, {
            descriptionNormalized: 'unrelated identity purchase',
            providerIdentityHash: starbucksHash,
          }),
        ).resolves.toMatchObject({
          merchant: { id: starbucksA.id },
          method: 'PROVIDER_IDENTITY',
        });

        const cafeteria = await repository.createCanonicalMerchant(workspaceA, {
          actorId: 'owner-a',
          canonicalName: 'Cafeteria Central',
        });
        const prefixAliasId = await repository.confirmAlias(workspaceA, {
          actorId: 'owner-a',
          alias: 'cafeteria central',
          matchType: 'PREFIX',
          merchantId: cafeteria.id,
        });
        await expect(
          repository.resolve(workspaceA, {
            descriptionNormalized: 'cafeteria central loja 002',
          }),
        ).resolves.toMatchObject({
          matchedAliasId: prefixAliasId,
          merchant: { id: cafeteria.id },
          method: 'PATTERN_ALIAS',
        });

        const fuzzy = await repository.resolve(workspaceA, {
          descriptionNormalized: 'starbuks',
        });
        expect(fuzzy).toMatchObject({
          merchant: { normalizedKey: 'starbuks', reviewStatus: 'NEEDS_REVIEW' },
          method: 'PROVISIONAL',
        });
        expect(fuzzy.merchant.id).not.toBe(starbucksA.id);
        expect(fuzzy.reviewCandidates).toContainEqual({
          canonicalName: 'Starbucks',
          merchantId: starbucksA.id,
          reason: 'FUZZY_TEXT',
          similarity: '0.8000',
        });

        const northCoffee = await repository.createCanonicalMerchant(workspaceA, {
          actorId: 'owner-a',
          canonicalName: 'North Coffee',
        });
        const coffeeHouse = await repository.createCanonicalMerchant(workspaceA, {
          actorId: 'owner-a',
          canonicalName: 'Coffee House',
        });
        await repository.confirmAlias(workspaceA, {
          actorId: 'owner-a',
          alias: 'north',
          matchType: 'CONTAINS',
          merchantId: northCoffee.id,
        });
        await repository.confirmAlias(workspaceA, {
          actorId: 'owner-a',
          alias: 'coffee',
          matchType: 'CONTAINS',
          merchantId: coffeeHouse.id,
        });
        const ambiguous = await repository.resolve(workspaceA, {
          descriptionNormalized: 'north coffee kiosk',
        });
        expect(ambiguous.method).toBe('PROVISIONAL');
        expect(ambiguous.merchant.id).not.toBe(northCoffee.id);
        expect(ambiguous.merchant.id).not.toBe(coffeeHouse.id);
        expect(ambiguous.reviewCandidates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              merchantId: northCoffee.id,
              reason: 'AMBIGUOUS_PATTERN_ALIAS',
            }),
            expect.objectContaining({
              merchantId: coffeeHouse.id,
              reason: 'AMBIGUOUS_PATTERN_ALIAS',
            }),
          ]),
        );

        const concurrent = await Promise.all(
          Array.from({ length: 12 }, () =>
            repository.resolve(workspaceA, { descriptionNormalized: 'nova padaria bairro' }),
          ),
        );
        expect(new Set(concurrent.map(({ merchant }) => merchant.id)).size).toBe(1);
        expect(concurrent.filter(({ method }) => method === 'PROVISIONAL')).toHaveLength(1);
        expect(
          await pool.query<{ count: number }>(
            `select count(*)::integer as count from merchant
             where workspace_id = $1 and normalized_key = 'nova padaria bairro'`,
            [workspaceA],
          ),
        ).toMatchObject({ rows: [{ count: 1 }] });

        const concurrentIdentityHash = 'b'.repeat(64);
        const concurrentIdentity = await Promise.all([
          repository.resolve(workspaceA, {
            descriptionNormalized: 'identity candidate one',
            providerIdentityHash: concurrentIdentityHash,
            providerMerchantName: 'Identity Candidate One',
          }),
          repository.resolve(workspaceA, {
            descriptionNormalized: 'identity candidate two',
            providerIdentityHash: concurrentIdentityHash,
            providerMerchantName: 'Identity Candidate Two',
          }),
        ]);
        expect(new Set(concurrentIdentity.map(({ merchant }) => merchant.id)).size).toBe(1);
        expect(concurrentIdentity.map(({ method }) => method).sort()).toEqual([
          'PROVIDER_IDENTITY',
          'PROVISIONAL',
        ]);
        expect(
          await pool.query<{ count: number }>(
            `select count(*)::integer as count from merchant
             where workspace_id = $1 and cnpj_hash = $2`,
            [workspaceA, concurrentIdentityHash],
          ),
        ).toMatchObject({ rows: [{ count: 1 }] });

        await pool.query(
          `insert into merchant_alias (
             workspace_id, merchant_id, alias_normalized, match_type, source, confidence
           ) values ($1, $2, 'unconfirmed provider alias', 'EXACT', 'PROVIDER', '1.0000')`,
          [workspaceA, starbucksA.id],
        );
        const unconfirmed = await repository.resolve(workspaceA, {
          descriptionNormalized: 'unconfirmed provider alias',
        });
        expect(unconfirmed.method).toBe('PROVISIONAL');
        expect(unconfirmed.merchant.id).not.toBe(starbucksA.id);

        const isolated = await repository.resolve(workspaceB, {
          descriptionNormalized: 'stbks brasil',
        });
        expect(isolated.method).toBe('PROVISIONAL');
        expect(isolated.merchant.workspaceId).toBe(workspaceB);
        expect(isolated.merchant.id).not.toBe(starbucksA.id);
        await expect(
          repository.confirmAlias(workspaceA, {
            actorId: 'owner-a',
            alias: 'cross workspace alias',
            matchType: 'EXACT',
            merchantId: starbucksB.id,
          }),
        ).rejects.toBeInstanceOf(MerchantResolutionInvariantError);
        await expect(
          repository.confirmAlias(workspaceA, {
            actorId: 'owner-a',
            alias: 'stbks brasil',
            matchType: 'EXACT',
            merchantId: cafeteria.id,
          }),
        ).rejects.toBeInstanceOf(MerchantAliasConflictError);

        const audit = await pool.query<{ count: number }>(
          `select count(*)::integer as count from audit_event
           where workspace_id = $1
             and event_type in ('MERCHANT_CANONICAL_CONFIRMED', 'MERCHANT_ALIAS_CONFIRMED')`,
          [workspaceA],
        );
        expect(audit.rows[0]?.count).toBe(8);
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)} with (force)`);
      await admin.end();
    }
  }, 30_000);
});
