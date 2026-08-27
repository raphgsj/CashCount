import { describe, expect, it } from 'vitest';

import {
  categoryPatchSchema,
  classificationRuleCreateSchema,
  classificationRulePreviewSchema,
  merchantMergeSchema,
  merchantPatchSchema,
} from './classification-management-contracts.js';

describe('classification management contracts', () => {
  it('accepts bounded explicit management writes', () => {
    expect(categoryPatchSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(merchantPatchSchema.parse({ reviewStatus: 'CONFIRMED' })).toEqual({
      reviewStatus: 'CONFIRMED',
    });
    expect(
      classificationRuleCreateSchema.parse({
        actions: { operations: [], version: '1' },
        conditions: {
          root: {
            field: 'transaction.descriptionNormalized',
            operator: 'contains',
            type: 'PREDICATE',
            value: 'market',
          },
          version: '1',
        },
        name: 'Synthetic rule',
        priority: 10,
      }),
    ).toBeDefined();
  });

  it('rejects empty patches, same-merchant merges, and unbounded previews', () => {
    expect(() => categoryPatchSchema.parse({})).toThrow();
    expect(() => merchantPatchSchema.parse({})).toThrow();
    const id = '10000000-0000-4000-8000-000000000063';
    expect(() =>
      merchantMergeSchema.parse({ sourceMerchantId: id, targetMerchantId: id }),
    ).toThrow();
    expect(() =>
      classificationRulePreviewSchema.parse({ from: '2026-08-31', to: '2026-08-01' }),
    ).toThrow();
  });

  it('keeps provider identities and hash fields outside public writes', () => {
    expect(() => merchantPatchSchema.parse({ cnpjHash: 'a'.repeat(64) })).toThrow();
    expect(() =>
      classificationRuleCreateSchema.parse({
        actions: {},
        conditions: {},
        name: 'Rule',
        priority: 0,
        source: 'IMPORT',
      }),
    ).toThrow();
  });
});
