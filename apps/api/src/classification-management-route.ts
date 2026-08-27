import { randomUUID } from 'node:crypto';

import {
  classificationRuleActionsSchema,
  classificationRuleConditionsSchema,
} from '@cashcount/classification';
import {
  categoryCreateSchema,
  categoryPatchSchema,
  classificationRuleCreateSchema,
  classificationRulePatchSchema,
  classificationRulePreviewResultSchema,
  classificationRulePreviewSchema,
  managedCategorySchema,
  managedClassificationRuleSchema,
  managedMerchantSchema,
  merchantMergeSchema,
  merchantPatchSchema,
  type CategoryCreate,
  type CategoryPatch,
  type ClassificationRuleCreate,
  type ClassificationRulePatch,
  type ClassificationRulePreview,
  type ManagedCategory,
  type ManagedClassificationRule,
  type ManagedMerchant,
  type MerchantPatch,
} from '@cashcount/contracts';
import {
  ClassificationManagementInvariantError,
  ClassificationManagementNotFoundError,
  type CreateManagedCategoryInput,
  type ManagedCategoryRecord,
  type ManagedClassificationRuleRecord,
  type ManagedMerchantRecord,
  type ManagedRulePreviewResult,
  type UpdateManagedCategoryInput,
  type UpdateManagedMerchantInput,
  type UpdateManagedRuleInput,
} from '@cashcount/db/finance';
import { z } from 'zod';

import { maskSensitiveDigitSequences } from './public-text.js';
import { requireWebOwnerCredential } from './web-owner-auth.js';

const canonicalUuidSchema = z.uuid();

export interface ClassificationManagementRouteRepository {
  createCategory(
    workspaceId: string,
    input: CreateManagedCategoryInput,
  ): Promise<ManagedCategoryRecord>;
  createRule(
    workspaceId: string,
    input: {
      actions: unknown;
      actorId: string;
      conditions: unknown;
      name: string;
      priority: number;
      stopProcessing?: boolean;
    },
  ): Promise<ManagedClassificationRuleRecord>;
  deactivateRule(workspaceId: string, ruleId: string, actorId: string): Promise<void>;
  getMerchant(workspaceId: string, merchantId: string): Promise<ManagedMerchantRecord | null>;
  listCategories(workspaceId: string, limit?: number): Promise<ManagedCategoryRecord[]>;
  listMerchants(workspaceId: string, limit?: number): Promise<ManagedMerchantRecord[]>;
  listRules(workspaceId: string, limit?: number): Promise<ManagedClassificationRuleRecord[]>;
  mergeMerchants(
    workspaceId: string,
    sourceMerchantId: string,
    targetMerchantId: string,
    actorId: string,
  ): Promise<ManagedMerchantRecord>;
  previewRule(
    workspaceId: string,
    ruleId: string,
    input: { from: string; limit: number; to: string },
  ): Promise<ManagedRulePreviewResult>;
  updateCategory(
    workspaceId: string,
    categoryId: string,
    input: UpdateManagedCategoryInput,
  ): Promise<ManagedCategoryRecord>;
  updateMerchant(
    workspaceId: string,
    merchantId: string,
    input: UpdateManagedMerchantInput,
  ): Promise<ManagedMerchantRecord>;
  updateRule(
    workspaceId: string,
    ruleId: string,
    input: UpdateManagedRuleInput,
  ): Promise<ManagedClassificationRuleRecord>;
}

export interface ClassificationManagementRouteDependencies {
  actorId: string;
  now?: () => Date;
  repository: ClassificationManagementRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface ClassificationManagementRouteRequest {
  authorizationHeader: null | string;
  body: unknown;
  hasBody: boolean;
  method: string;
  url: URL;
}

export interface ClassificationManagementRouteResult {
  body: unknown;
  headers: Readonly<Record<string, string>>;
  status: number;
}

function problem(
  status: number,
  title: string,
  code: string,
  requestId: string,
): ClassificationManagementRouteResult {
  return {
    body: {
      code,
      requestId,
      status,
      title,
      type: `https://cashcount.invalid/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    },
    headers: { 'x-request-id': requestId },
    status,
  };
}

function categoryJson(record: ManagedCategoryRecord): ManagedCategory {
  return managedCategorySchema.parse(record);
}

function merchantJson(record: ManagedMerchantRecord): ManagedMerchant {
  return managedMerchantSchema.parse({
    ...record,
    aliases: record.aliases.map((alias) => ({
      ...alias,
      alias: maskSensitiveDigitSequences(alias.alias),
    })),
  });
}

function ruleJson(record: ManagedClassificationRuleRecord): ManagedClassificationRule {
  return managedClassificationRuleSchema.parse({
    actions: record.actions,
    conditions: record.conditions,
    createdAt: record.createdAt.toISOString(),
    hitCount: record.hitCount,
    id: record.id,
    isActive: record.isActive,
    name: record.name,
    priority: record.priority,
    source: record.source,
    stopProcessing: record.stopProcessing,
    updatedAt: record.updatedAt.toISOString(),
  });
}

function parseLimit(searchParams: URLSearchParams): number | null {
  if ([...searchParams.keys()].some((key) => key !== 'limit')) return null;
  if (searchParams.getAll('limit').length > 1) return null;
  const raw = searchParams.get('limit');
  if (raw === null) return 100;
  if (!/^[1-9]\d*$/u.test(raw)) return null;
  const limit = Number(raw);
  return Number.isSafeInteger(limit) && limit <= 100 ? limit : null;
}

function categoryCreateInput(input: CategoryCreate, actorId: string): CreateManagedCategoryInput {
  return {
    actorId,
    ...(input.iconKey === undefined ? {} : { iconKey: input.iconKey }),
    kind: input.kind,
    nameEn: input.nameEn,
    namePtBr: input.namePtBr,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
  };
}

function categoryUpdateInput(input: CategoryPatch, actorId: string): UpdateManagedCategoryInput {
  return {
    actorId,
    ...(input.iconKey === undefined ? {} : { iconKey: input.iconKey }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.nameEn === undefined ? {} : { nameEn: input.nameEn }),
    ...(input.namePtBr === undefined ? {} : { namePtBr: input.namePtBr }),
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
  };
}

function merchantUpdateInput(input: MerchantPatch, actorId: string): UpdateManagedMerchantInput {
  return {
    actorId,
    ...(input.canonicalName === undefined ? {} : { canonicalName: input.canonicalName }),
    ...(input.defaultCategoryId === undefined
      ? {}
      : { defaultCategoryId: input.defaultCategoryId }),
    ...(input.mcc === undefined ? {} : { mcc: input.mcc }),
    ...(input.merchantGroup === undefined ? {} : { merchantGroup: input.merchantGroup }),
    ...(input.reviewStatus === undefined ? {} : { reviewStatus: input.reviewStatus }),
  };
}

function ruleCreateInput(input: ClassificationRuleCreate, actorId: string) {
  return {
    actions: classificationRuleActionsSchema.parse(input.actions),
    actorId,
    conditions: classificationRuleConditionsSchema.parse(input.conditions),
    name: input.name,
    priority: input.priority,
    ...(input.stopProcessing === undefined ? {} : { stopProcessing: input.stopProcessing }),
  };
}

function ruleUpdateInput(input: ClassificationRulePatch, actorId: string): UpdateManagedRuleInput {
  return {
    ...(input.actions === undefined
      ? {}
      : { actions: classificationRuleActionsSchema.parse(input.actions) }),
    actorId,
    ...(input.conditions === undefined
      ? {}
      : { conditions: classificationRuleConditionsSchema.parse(input.conditions) }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.stopProcessing === undefined ? {} : { stopProcessing: input.stopProcessing }),
  };
}

function previewJson(result: ManagedRulePreviewResult) {
  return classificationRulePreviewResultSchema.parse({
    ...result,
    matches: result.matches.map((match) => ({
      ...match,
      description: maskSensitiveDigitSequences(match.description),
    })),
  });
}

function databaseConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export async function processClassificationManagementRequest(
  request: ClassificationManagementRouteRequest,
  dependencies: ClassificationManagementRouteDependencies,
): Promise<ClassificationManagementRouteResult | null> {
  const path = request.url.pathname;
  const categoryDetail = /^\/v1\/categories\/([^/]+)$/u.exec(path);
  const merchantDetail = /^\/v1\/merchants\/([^/]+)$/u.exec(path);
  const ruleTest = /^\/v1\/classification-rules\/([^/]+)\/test$/u.exec(path);
  const ruleDetail = /^\/v1\/classification-rules\/([^/]+)$/u.exec(path);
  const recognized =
    path === '/v1/categories' ||
    path === '/v1/merchants' ||
    path === '/v1/merchants/merge' ||
    path === '/v1/classification-rules' ||
    categoryDetail !== null ||
    merchantDetail !== null ||
    ruleTest !== null ||
    ruleDetail !== null;
  if (!recognized) return null;

  const requestId = dependencies.requestId?.() ?? randomUUID();
  if (!canonicalUuidSchema.safeParse(requestId).success) {
    throw new TypeError('Classification management request IDs must be canonical UUIDs.');
  }
  if (!requireWebOwnerCredential(request.authorizationHeader, dependencies.webToken)) {
    return problem(401, 'Unauthorized', 'UNAUTHORIZED', requestId);
  }
  const meta = {
    generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    requestId,
    workspaceId: dependencies.workspaceId,
  };
  const success = (
    data: unknown,
    status = 200,
    headers: Readonly<Record<string, string>> = {},
  ): ClassificationManagementRouteResult => ({
    body: status === 204 ? null : { data, meta },
    headers: { ...headers, 'x-request-id': requestId },
    status,
  });
  const parseId = (match: RegExpExecArray): null | string => {
    const parsed = canonicalUuidSchema.safeParse(match[1]);
    return parsed.success ? parsed.data : null;
  };

  try {
    if (path === '/v1/categories') {
      if (request.method === 'GET') {
        if (request.hasBody) {
          return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
        }
        const limit = parseLimit(request.url.searchParams);
        if (limit === null) return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
        return success({
          items: (
            await dependencies.repository.listCategories(dependencies.workspaceId, limit)
          ).map(categoryJson),
          limit,
        });
      }
      if (request.method === 'POST') {
        if (request.url.search.length > 0) {
          return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
        }
        const input = categoryCreateSchema.safeParse(request.body);
        if (!request.hasBody || !input.success) {
          return problem(400, 'Invalid category body', 'INVALID_BODY', requestId);
        }
        const created = categoryJson(
          await dependencies.repository.createCategory(
            dependencies.workspaceId,
            categoryCreateInput(input.data, dependencies.actorId),
          ),
        );
        return success(created, 201, { location: `/v1/categories/${created.id}` });
      }
      const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
      return { ...result, headers: { ...result.headers, allow: 'GET, POST' } };
    }

    if (categoryDetail !== null) {
      if (request.url.search.length > 0) {
        return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
      }
      if (request.method !== 'PATCH') {
        const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
        return { ...result, headers: { ...result.headers, allow: 'PATCH' } };
      }
      const id = parseId(categoryDetail);
      const input = categoryPatchSchema.safeParse(request.body);
      if (id === null) return problem(400, 'Invalid ID', 'INVALID_ID', requestId);
      if (!request.hasBody || !input.success) {
        return problem(400, 'Invalid category body', 'INVALID_BODY', requestId);
      }
      return success(
        categoryJson(
          await dependencies.repository.updateCategory(
            dependencies.workspaceId,
            id,
            categoryUpdateInput(input.data, dependencies.actorId),
          ),
        ),
      );
    }

    if (path === '/v1/merchants/merge') {
      if (request.method !== 'POST') {
        const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
        return { ...result, headers: { ...result.headers, allow: 'POST' } };
      }
      if (request.url.search.length > 0) {
        return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
      }
      const input = merchantMergeSchema.safeParse(request.body);
      if (!request.hasBody || !input.success) {
        return problem(400, 'Invalid merchant merge body', 'INVALID_BODY', requestId);
      }
      return success(
        merchantJson(
          await dependencies.repository.mergeMerchants(
            dependencies.workspaceId,
            input.data.sourceMerchantId,
            input.data.targetMerchantId,
            dependencies.actorId,
          ),
        ),
      );
    }

    if (path === '/v1/merchants') {
      if (request.hasBody) {
        return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
      }
      if (request.method !== 'GET') {
        const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
        return { ...result, headers: { ...result.headers, allow: 'GET' } };
      }
      const limit = parseLimit(request.url.searchParams);
      if (limit === null) return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
      return success({
        items: (await dependencies.repository.listMerchants(dependencies.workspaceId, limit)).map(
          merchantJson,
        ),
        limit,
      });
    }

    if (merchantDetail !== null) {
      if (request.url.search.length > 0) {
        return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
      }
      const id = parseId(merchantDetail);
      if (id === null) return problem(400, 'Invalid ID', 'INVALID_ID', requestId);
      if (request.method === 'GET') {
        if (request.hasBody) {
          return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
        }
        const record = await dependencies.repository.getMerchant(dependencies.workspaceId, id);
        return record === null
          ? problem(404, 'Merchant not found', 'NOT_FOUND', requestId)
          : success(merchantJson(record));
      }
      if (request.method === 'PATCH') {
        const input = merchantPatchSchema.safeParse(request.body);
        if (!request.hasBody || !input.success) {
          return problem(400, 'Invalid merchant body', 'INVALID_BODY', requestId);
        }
        return success(
          merchantJson(
            await dependencies.repository.updateMerchant(
              dependencies.workspaceId,
              id,
              merchantUpdateInput(input.data, dependencies.actorId),
            ),
          ),
        );
      }
      const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
      return { ...result, headers: { ...result.headers, allow: 'GET, PATCH' } };
    }

    if (path === '/v1/classification-rules') {
      if (request.method === 'GET') {
        if (request.hasBody) {
          return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
        }
        const limit = parseLimit(request.url.searchParams);
        if (limit === null) return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
        return success({
          items: (await dependencies.repository.listRules(dependencies.workspaceId, limit)).map(
            ruleJson,
          ),
          limit,
        });
      }
      if (request.method === 'POST') {
        if (request.url.search.length > 0) {
          return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
        }
        const input = classificationRuleCreateSchema.safeParse(request.body);
        if (!request.hasBody || !input.success) {
          return problem(400, 'Invalid rule body', 'INVALID_BODY', requestId);
        }
        const created = ruleJson(
          await dependencies.repository.createRule(
            dependencies.workspaceId,
            ruleCreateInput(input.data, dependencies.actorId),
          ),
        );
        return success(created, 201, { location: `/v1/classification-rules/${created.id}` });
      }
      const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
      return { ...result, headers: { ...result.headers, allow: 'GET, POST' } };
    }

    if (ruleTest !== null) {
      if (request.method !== 'POST') {
        const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
        return { ...result, headers: { ...result.headers, allow: 'POST' } };
      }
      if (request.url.search.length > 0) {
        return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
      }
      const id = parseId(ruleTest);
      const input = classificationRulePreviewSchema.safeParse(request.body);
      if (id === null) return problem(400, 'Invalid ID', 'INVALID_ID', requestId);
      if (!request.hasBody || !input.success) {
        return problem(400, 'Invalid rule preview body', 'INVALID_BODY', requestId);
      }
      const days =
        (Date.parse(`${input.data.to}T00:00:00Z`) - Date.parse(`${input.data.from}T00:00:00Z`)) /
        86_400_000;
      if (days > 366) return problem(400, 'Invalid rule preview range', 'INVALID_BODY', requestId);
      return success(
        previewJson(
          await dependencies.repository.previewRule(
            dependencies.workspaceId,
            id,
            input.data as ClassificationRulePreview,
          ),
        ),
      );
    }

    if (ruleDetail !== null) {
      if (request.url.search.length > 0) {
        return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
      }
      const id = parseId(ruleDetail);
      if (id === null) return problem(400, 'Invalid ID', 'INVALID_ID', requestId);
      if (request.method === 'PATCH') {
        const input = classificationRulePatchSchema.safeParse(request.body);
        if (!request.hasBody || !input.success) {
          return problem(400, 'Invalid rule body', 'INVALID_BODY', requestId);
        }
        return success(
          ruleJson(
            await dependencies.repository.updateRule(
              dependencies.workspaceId,
              id,
              ruleUpdateInput(input.data, dependencies.actorId),
            ),
          ),
        );
      }
      if (request.method === 'DELETE') {
        if (request.hasBody) {
          return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
        }
        await dependencies.repository.deactivateRule(
          dependencies.workspaceId,
          id,
          dependencies.actorId,
        );
        return success(null, 204);
      }
      const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
      return { ...result, headers: { ...result.headers, allow: 'PATCH, DELETE' } };
    }
  } catch (error) {
    if (error instanceof ClassificationManagementNotFoundError) {
      return problem(404, 'Resource not found', 'NOT_FOUND', requestId);
    }
    if (databaseConflict(error)) {
      return problem(409, 'Resource conflict', 'CONFLICT', requestId);
    }
    if (
      error instanceof ClassificationManagementInvariantError ||
      error instanceof TypeError ||
      error instanceof z.ZodError
    ) {
      return problem(400, 'Invalid management request', 'INVALID_REQUEST', requestId);
    }
    throw error;
  }
  return null;
}
