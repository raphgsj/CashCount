import { Buffer } from 'node:buffer';

import type {
  ClassificationRuleActions,
  ClassificationRuleConditions,
} from '@cashcount/classification';
import {
  ClassificationManagementNotFoundError,
  type ManagedCategoryRecord,
  type ManagedClassificationRuleRecord,
  type ManagedMerchantRecord,
} from '@cashcount/db/finance';
import { describe, expect, it, vi } from 'vitest';

import {
  processClassificationManagementRequest,
  type ClassificationManagementRouteDependencies,
  type ClassificationManagementRouteRepository,
} from './classification-management-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000063';
const categoryId = '20000000-0000-4000-8000-000000000063';
const sourceMerchantId = '30000000-0000-4000-8000-000000000063';
const targetMerchantId = '30000000-0000-4000-8000-000000000064';
const ruleId = '40000000-0000-4000-8000-000000000063';
const transactionId = '50000000-0000-4000-8000-000000000063';
const requestId = '60000000-0000-4000-8000-000000000063';
const webToken = Buffer.alloc(32, 63).toString('base64url');

const conditions: ClassificationRuleConditions = {
  root: {
    field: 'transaction.descriptionNormalized',
    operator: 'contains',
    type: 'PREDICATE',
    value: 'mercado',
  },
  version: '1',
};
const actions: ClassificationRuleActions = {
  operations: [{ categoryId, type: 'SET_CATEGORY' }],
  version: '1',
};

function category(): ManagedCategoryRecord {
  return {
    code: `custom.${categoryId}`,
    iconKey: null,
    id: categoryId,
    isActive: true,
    kind: 'EXPENSE',
    nameEn: 'Markets',
    namePtBr: 'Mercados',
    parentId: null,
    scope: 'WORKSPACE',
    sortOrder: 10,
  };
}

function merchant(): ManagedMerchantRecord {
  return {
    aliases: [
      {
        alias: 'market card 4111111111111111 cpf 123.456.789-09',
        confidence: '1.0000',
        id: '31000000-0000-4000-8000-000000000063',
        isActive: true,
        isConfirmed: true,
        matchType: 'EXACT',
        source: 'USER',
      },
    ],
    canonicalName: 'Target Market',
    defaultCategoryId: categoryId,
    id: targetMerchantId,
    mcc: '5411',
    merchantGroup: null,
    reviewStatus: 'CONFIRMED',
  };
}

function rule(
  overrides: Partial<ManagedClassificationRuleRecord> = {},
): ManagedClassificationRuleRecord {
  return {
    actions,
    conditions,
    createdAt: new Date('2026-08-26T12:00:00Z'),
    hitCount: '0',
    id: ruleId,
    isActive: true,
    name: 'Markets',
    priority: 50,
    source: 'USER',
    stopProcessing: false,
    updatedAt: new Date('2026-08-26T12:00:00Z'),
    workspaceId,
    ...overrides,
  };
}

function repository(): ClassificationManagementRouteRepository {
  return {
    createCategory: vi.fn(async () => category()),
    createRule: vi.fn(async () => rule()),
    deactivateRule: vi.fn(async () => undefined),
    getMerchant: vi.fn(async () => merchant()),
    listCategories: vi.fn(async () => [category()]),
    listMerchants: vi.fn(async () => [merchant()]),
    listRules: vi.fn(async () => [rule()]),
    mergeMerchants: vi.fn(async () => merchant()),
    previewRule: vi.fn(async () => ({
      matches: [
        {
          description: 'pix cpf 123.456.789-09 card 4111111111111111 mercado',
          localDate: '2026-08-26',
          transactionId,
          wouldStopProcessing: false,
        },
      ],
      policyVersion: 'rule-evaluation-v1' as const,
      scannedCount: 1,
      truncated: false,
    })),
    updateCategory: vi.fn(async () => category()),
    updateMerchant: vi.fn(async () => merchant()),
    updateRule: vi.fn(async () => rule()),
  };
}

function dependencies(repo = repository()): ClassificationManagementRouteDependencies {
  return {
    actorId: 'service_web',
    now: () => new Date('2026-08-26T13:00:00Z'),
    repository: repo,
    requestId: () => requestId,
    webToken,
    workspaceId,
  };
}

function request(method: string, path: string, body?: unknown, token = webToken) {
  return {
    authorizationHeader: `Bearer ${token}`,
    body,
    hasBody: body !== undefined,
    method,
    url: new URL(path, 'http://cashcount.invalid'),
  };
}

describe('classification management route', () => {
  it('lists and creates bounded workspace categories', async () => {
    const repo = repository();
    const listed = await processClassificationManagementRequest(
      request('GET', '/v1/categories?limit=20'),
      dependencies(repo),
    );
    expect(listed?.status).toBe(200);
    expect(listed?.body).toMatchObject({
      data: { items: [{ id: categoryId, scope: 'WORKSPACE' }], limit: 20 },
      meta: { workspaceId },
    });
    expect(repo.listCategories).toHaveBeenCalledWith(workspaceId, 20);

    const created = await processClassificationManagementRequest(
      request('POST', '/v1/categories', {
        kind: 'EXPENSE',
        nameEn: 'Markets',
        namePtBr: 'Mercados',
      }),
      dependencies(repo),
    );
    expect(created?.status).toBe(201);
    expect(created?.headers).toMatchObject({ location: `/v1/categories/${categoryId}` });
    expect(repo.createCategory).toHaveBeenCalledWith(workspaceId, {
      actorId: 'service_web',
      kind: 'EXPENSE',
      nameEn: 'Markets',
      namePtBr: 'Mercados',
    });
  });

  it('updates and merges merchants without accepting private identity fields', async () => {
    const repo = repository();
    const patched = await processClassificationManagementRequest(
      request('PATCH', `/v1/merchants/${targetMerchantId}`, {
        defaultCategoryId: categoryId,
        reviewStatus: 'CONFIRMED',
      }),
      dependencies(repo),
    );
    expect(patched?.status).toBe(200);
    expect(repo.updateMerchant).toHaveBeenCalledWith(workspaceId, targetMerchantId, {
      actorId: 'service_web',
      defaultCategoryId: categoryId,
      reviewStatus: 'CONFIRMED',
    });
    expect(JSON.stringify(patched?.body)).not.toMatch(/cnpj|normalizedKey|provider/iu);
    expect(JSON.stringify(patched?.body)).not.toMatch(/123\.456\.789-09|4111111111111111/u);
    expect(JSON.stringify(patched?.body)).toContain('••••1111');

    const merged = await processClassificationManagementRequest(
      request('POST', '/v1/merchants/merge', {
        sourceMerchantId,
        targetMerchantId,
      }),
      dependencies(repo),
    );
    expect(merged?.status).toBe(200);
    expect(repo.mergeMerchants).toHaveBeenCalledWith(
      workspaceId,
      sourceMerchantId,
      targetMerchantId,
      'service_web',
    );

    const privateWrite = await processClassificationManagementRequest(
      request('PATCH', `/v1/merchants/${targetMerchantId}`, { cnpjHash: 'secret' }),
      dependencies(repo),
    );
    expect(privateWrite?.status).toBe(400);
  });

  it('enforces the strict DSL and performs masked prospective previews', async () => {
    const repo = repository();
    const created = await processClassificationManagementRequest(
      request('POST', '/v1/classification-rules', {
        actions,
        conditions,
        name: 'Markets',
        priority: 50,
      }),
      dependencies(repo),
    );
    expect(created?.status).toBe(201);
    expect(repo.createRule).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ actorId: 'service_web' }),
    );

    const unsafe = await processClassificationManagementRequest(
      request('POST', '/v1/classification-rules', {
        actions: { operations: [], version: '1' },
        conditions: {
          root: {
            field: 'transaction.rawPayload',
            operator: 'eq',
            type: 'PREDICATE',
            value: 'secret',
          },
          version: '1',
        },
        name: 'Unsafe',
        priority: 1,
      }),
      dependencies(repo),
    );
    expect(unsafe?.status).toBe(400);

    const preview = await processClassificationManagementRequest(
      request('POST', `/v1/classification-rules/${ruleId}/test`, {
        from: '2026-08-01',
        to: '2026-08-31',
      }),
      dependencies(repo),
    );
    expect(preview?.status).toBe(200);
    expect(repo.previewRule).toHaveBeenCalledWith(workspaceId, ruleId, {
      from: '2026-08-01',
      limit: 50,
      to: '2026-08-31',
    });
    expect(JSON.stringify(preview?.body)).not.toMatch(/123\.456\.789-09|4111111111111111/u);
    expect(JSON.stringify(preview?.body)).toContain('••••1111');
  });

  it('requires owner credentials, bounds inputs, maps isolation misses, and deactivates on delete', async () => {
    const repo = repository();
    const unauthorized = await processClassificationManagementRequest(
      request('GET', '/v1/categories', undefined, Buffer.alloc(32, 64).toString('base64url')),
      dependencies(repo),
    );
    expect(unauthorized?.status).toBe(401);
    expect(repo.listCategories).not.toHaveBeenCalled();

    expect(
      (
        await processClassificationManagementRequest(
          request('GET', '/v1/categories?limit=101'),
          dependencies(repo),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await processClassificationManagementRequest(
          request('POST', `/v1/classification-rules/${ruleId}/test`, {
            from: '2025-01-01',
            to: '2026-08-26',
          }),
          dependencies(repo),
        )
      )?.status,
    ).toBe(400);

    repo.updateCategory = vi.fn(async () => {
      throw new ClassificationManagementNotFoundError('category');
    });
    expect(
      (
        await processClassificationManagementRequest(
          request('PATCH', `/v1/categories/${categoryId}`, { nameEn: 'Invisible' }),
          dependencies(repo),
        )
      )?.status,
    ).toBe(404);

    const deleted = await processClassificationManagementRequest(
      request('DELETE', `/v1/classification-rules/${ruleId}`),
      dependencies(repo),
    );
    expect(deleted?.status).toBe(204);
    expect(deleted?.body).toBeNull();
    expect(repo.deactivateRule).toHaveBeenCalledWith(workspaceId, ruleId, 'service_web');
  });
});
