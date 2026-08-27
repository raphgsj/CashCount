import { randomUUID } from 'node:crypto';

import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { processSyncOperationalRequest } from './sync-operational-route.js';
import {
  processAccountCardRequest,
  type AccountCardRouteDependencies,
} from './account-card-route.js';
import {
  processTransactionRequest,
  type TransactionRouteDependencies,
} from './transaction-route.js';
import {
  processClassificationManagementRequest,
  type ClassificationManagementRouteDependencies,
} from './classification-management-route.js';
import { processAnalyticsRequest, type AnalyticsRouteDependencies } from './analytics-route.js';
import {
  processBillReconciliationRequest,
  type BillReconciliationRouteDependencies,
} from './bill-reconciliation-route.js';
import {
  processInstallmentRequest,
  type InstallmentRouteDependencies,
} from './installment-route.js';
import { processRecurringRequest, type RecurringRouteDependencies } from './recurring-route.js';
import {
  processAnomalyForecastRequest,
  type AnomalyForecastRouteDependencies,
} from './anomaly-forecast-route.js';
import {
  pluggyWebhookBodyLimitBytes,
  processPluggyWebhookBody,
  type PluggyWebhookRouteDependencies,
} from './webhook-route.js';
import { requirePluggyWebhookCredential } from './webhook-auth.js';

export interface ApiServerDependencies extends PluggyWebhookRouteDependencies {
  accountCards?: AccountCardRouteDependencies;
  analytics?: AnalyticsRouteDependencies;
  anomalyForecast?: AnomalyForecastRouteDependencies;
  billReconciliation?: BillReconciliationRouteDependencies;
  classificationManagement?: ClassificationManagementRouteDependencies;
  installments?: InstallmentRouteDependencies;
  mcpToken: string;
  nodeEnvironment: 'development' | 'production' | 'test';
  readiness?: () => Promise<boolean>;
  recurring?: RecurringRouteDependencies;
  transactions?: TransactionRouteDependencies;
  workspaceId: string;
}

interface FastifyErrorLike extends Error {
  code?: string;
  statusCode?: number;
}

function problem(status: number, title: string, code: string, requestId: string) {
  return {
    code,
    requestId,
    status,
    title,
    type: `https://cashcount.invalid/problems/${code.toLowerCase().replaceAll('_', '-')}`,
  };
}

function hasRequestBody(request: FastifyRequest): boolean {
  if (request.body !== undefined) return true;
  if (request.headers['transfer-encoding'] !== undefined) return true;
  const length = request.headers['content-length'];
  return typeof length === 'string' && length !== '0';
}

async function sendOperationalResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.operational === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processSyncOperationalRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      hasBody: hasRequestBody(request),
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.operational, requestId: () => request.id },
  );
  if (result === null) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

async function sendAccountCardResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.accountCards === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processAccountCardRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      hasBody: hasRequestBody(request),
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.accountCards, requestId: () => request.id },
  );
  if (result === null) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

async function sendTransactionResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.transactions === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processTransactionRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      body: request.body,
      hasBody: hasRequestBody(request),
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.transactions, requestId: () => request.id },
  );
  if (result === null) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

async function sendClassificationManagementResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.classificationManagement === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processClassificationManagementRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      body: request.body,
      hasBody: hasRequestBody(request),
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.classificationManagement, requestId: () => request.id },
  );
  if (result === null) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

async function sendAnalyticsResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.analytics === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processAnalyticsRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      hasBody: hasRequestBody(request),
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.analytics, requestId: () => request.id },
  );
  if (result === null) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

async function sendBillReconciliationResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.billReconciliation === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processBillReconciliationRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      body: request.body,
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.billReconciliation, requestId: () => request.id },
  );
  if (result === null) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

async function sendInstallmentResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.installments === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processInstallmentRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      hasBody: hasRequestBody(request),
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.installments, requestId: () => request.id },
  );
  if (result === null)
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

async function sendRecurringResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.recurring === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processRecurringRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      body: request.body,
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.recurring, requestId: () => request.id },
  );
  if (result === null)
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

async function sendAnomalyForecastResult(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ApiServerDependencies,
): Promise<unknown> {
  if (dependencies.anomalyForecast === undefined) {
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  }
  const result = await processAnomalyForecastRequest(
    {
      authorizationHeader: request.headers.authorization ?? null,
      hasBody: hasRequestBody(request),
      method: request.method,
      url: new URL(request.url, 'http://cashcount.invalid'),
    },
    { ...dependencies.anomalyForecast, requestId: () => request.id },
  );
  if (result === null)
    return reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id));
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return reply.code(result.status).send(result.body);
}

export function createApiServer(dependencies: ApiServerDependencies): FastifyInstance {
  if (
    dependencies.anomalyForecast !== undefined &&
    dependencies.anomalyForecast.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.analytics !== undefined &&
    dependencies.analytics.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.billReconciliation !== undefined &&
    dependencies.billReconciliation.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.installments !== undefined &&
    dependencies.installments.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.recurring !== undefined &&
    dependencies.recurring.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.operational !== undefined &&
    dependencies.operational.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.accountCards !== undefined &&
    dependencies.accountCards.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.transactions !== undefined &&
    dependencies.transactions.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.classificationManagement !== undefined &&
    dependencies.classificationManagement.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  if (
    dependencies.analytics !== undefined &&
    dependencies.analytics.mcpToken !== dependencies.mcpToken
  ) {
    throw new TypeError('Analytics routes must use the configured MCP credential.');
  }
  if (
    dependencies.anomalyForecast !== undefined &&
    dependencies.anomalyForecast.mcpToken !== dependencies.mcpToken
  ) {
    throw new TypeError('Anomaly and forecast routes must use the configured MCP credential.');
  }
  if (
    dependencies.billReconciliation !== undefined &&
    dependencies.billReconciliation.mcpToken !== dependencies.mcpToken
  ) {
    throw new TypeError('Bill reconciliation routes must use the configured MCP credential.');
  }
  if (
    dependencies.installments !== undefined &&
    dependencies.installments.mcpToken !== dependencies.mcpToken
  ) {
    throw new TypeError('Installment routes must use the configured MCP credential.');
  }
  if (
    dependencies.recurring !== undefined &&
    dependencies.recurring.mcpToken !== dependencies.mcpToken
  ) {
    throw new TypeError('Recurring routes must use the configured MCP credential.');
  }
  const routeWebTokens = [
    dependencies.analytics?.webToken,
    dependencies.anomalyForecast?.webToken,
    dependencies.billReconciliation?.webToken,
    dependencies.operational?.webToken,
    dependencies.accountCards?.webToken,
    dependencies.transactions?.webToken,
    dependencies.classificationManagement?.webToken,
    dependencies.installments?.webToken,
    dependencies.recurring?.webToken,
  ].filter((value): value is string => value !== undefined);
  if (new Set(routeWebTokens).size > 1) {
    throw new TypeError('API route dependencies must use the configured web credential.');
  }
  const webToken = routeWebTokens[0];
  const credentials = [
    dependencies.webhookSecret,
    dependencies.mcpToken,
    ...(webToken === undefined ? [] : [webToken]),
  ];
  if (new Set(credentials).size !== credentials.length) {
    throw new TypeError('API trust-boundary credentials must be distinct.');
  }

  const server = Fastify({
    genReqId: () => randomUUID(),
    logger: false,
  });

  server.addHook('onSend', (request, reply, _payload, done) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-request-id', request.id);
    done();
  });

  if (dependencies.nodeEnvironment === 'development') {
    void server.register(swagger, {
      openapi: {
        components: {
          securitySchemes: {
            bearerAuth: { bearerFormat: 'Opaque', scheme: 'bearer', type: 'http' },
          },
        },
        info: { title: 'CashCount Finance API', version: '1.0.0' },
        openapi: '3.1.0',
      },
    });
    server.get(
      '/documentation/json',
      {
        schema: {
          description: 'Development-only generated OpenAPI document.',
          hide: true,
        },
      },
      async () => server.swagger(),
    );
  }

  const healthResponseSchema = {
    additionalProperties: false,
    properties: {
      meta: {
        additionalProperties: false,
        properties: { requestId: { format: 'uuid', type: 'string' } },
        required: ['requestId'],
        type: 'object',
      },
      status: { enum: ['live', 'ready'], type: 'string' },
    },
    required: ['meta', 'status'],
    type: 'object',
  } as const;
  server.get(
    '/health/live',
    { schema: { response: { 200: healthResponseSchema }, tags: ['health'] } },
    async (request) => ({ meta: { requestId: request.id }, status: 'live' }),
  );
  server.get('/health/ready', { schema: { tags: ['health'] } }, async (request, reply) => {
    try {
      const ready = (await dependencies.readiness?.()) ?? true;
      if (!ready) throw new Error('Readiness check failed.');
      return { meta: { requestId: request.id }, status: 'ready' };
    } catch {
      return reply.code(503).send(problem(503, 'Service unavailable', 'NOT_READY', request.id));
    }
  });

  for (const path of [
    '/v1/sync-runs',
    '/v1/sync-runs/:id',
    '/v1/jobs/dead-letter',
    '/v1/jobs/:id/retry',
    '/v1/connections/:id/reconcile',
  ]) {
    server.all(path, (request, reply) => sendOperationalResult(request, reply, dependencies));
  }

  for (const path of [
    '/v1/card-bills/:id/reconciliation',
    '/v1/bill-payments/:id/reconciliation-candidates',
    '/v1/bill-payments/:id/confirm-reconciliation',
    '/v1/bill-payments/:id/reject-reconciliation',
  ]) {
    server.all(path, (request, reply) =>
      sendBillReconciliationResult(request, reply, dependencies),
    );
  }

  server.all('/v1/analytics/spending-summary', (request, reply) =>
    sendAnalyticsResult(request, reply, dependencies),
  );
  server.all('/v1/analytics/compare-periods', (request, reply) =>
    sendAnalyticsResult(request, reply, dependencies),
  );
  server.all('/v1/analytics/installment-commitments', (request, reply) =>
    sendInstallmentResult(request, reply, dependencies),
  );
  server.all('/v1/analytics/recurring-expenses', (request, reply) =>
    sendRecurringResult(request, reply, dependencies),
  );
  for (const path of ['/v1/analytics/anomaly-candidates', '/v1/analytics/month-forecast']) {
    server.all(path, (request, reply) => sendAnomalyForecastResult(request, reply, dependencies));
  }

  for (const path of [
    '/v1/recurring-series',
    '/v1/recurring-expenses/detect',
    '/v1/recurring-series/:id/confirm',
    '/v1/recurring-series/:id/reject',
  ]) {
    server.all(path, (request, reply) => sendRecurringResult(request, reply, dependencies));
  }

  for (const path of [
    '/v1/accounts',
    '/v1/accounts/:id',
    '/v1/cards',
    '/v1/cards/:id',
    '/v1/cards/:id/bills',
    '/v1/cards/:id/installments',
    '/v1/card-bills/:id',
    '/v1/card-bills/:id/payments',
    '/v1/card-bills/:id/finance-charges',
  ]) {
    server.all(path, (request, reply) =>
      path.endsWith('/installments')
        ? sendInstallmentResult(request, reply, dependencies)
        : sendAccountCardResult(request, reply, dependencies),
    );
  }

  for (const path of ['/v1/transactions', '/v1/transactions/:id']) {
    server.all(path, (request, reply) => sendTransactionResult(request, reply, dependencies));
  }

  for (const path of [
    '/v1/categories',
    '/v1/categories/:id',
    '/v1/merchants',
    '/v1/merchants/merge',
    '/v1/merchants/:id',
    '/v1/classification-rules',
    '/v1/classification-rules/:id',
    '/v1/classification-rules/:id/test',
  ]) {
    server.all(path, (request, reply) =>
      sendClassificationManagementResult(request, reply, dependencies),
    );
  }

  void server.register(async (webhookScope) => {
    webhookScope.removeContentTypeParser('application/json');
    webhookScope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    webhookScope.post(
      '/webhooks/pluggy',
      {
        bodyLimit: dependencies.bodyLimitBytes ?? pluggyWebhookBodyLimitBytes,
        onRequest: (request, reply, done) => {
          if (
            !requirePluggyWebhookCredential(
              request.headers.authorization ?? null,
              dependencies.webhookSecret,
            )
          ) {
            void reply.code(401).send({ error: 'UNAUTHORIZED' });
            return;
          }
          if (
            request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !==
            'application/json'
          ) {
            void reply.code(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE' });
            return;
          }
          done();
        },
        schema: {
          description: 'Authenticated Pluggy webhook inbox insertion.',
          security: [{ bearerAuth: [] }],
          tags: ['webhook'],
        },
      },
      async (request, reply) => {
        const result = await processPluggyWebhookBody(
          request.headers.authorization ?? null,
          request.body as Buffer,
          dependencies,
        );
        return reply.code(result.status).send(result.body);
      },
    );
  });

  server.setNotFoundHandler((request, reply) =>
    reply.code(404).send(problem(404, 'Not found', 'NOT_FOUND', request.id)),
  );
  server.setErrorHandler((error: FastifyErrorLike, request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'PAYLOAD_TOO_LARGE' });
    }
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send(problem(error.statusCode, 'Invalid request', 'INVALID_REQUEST', request.id));
    }
    return reply
      .code(500)
      .send(problem(500, 'Internal server error', 'INTERNAL_ERROR', request.id));
  });

  return server;
}
