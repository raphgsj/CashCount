import { randomUUID } from 'node:crypto';

import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { processSyncOperationalRequest } from './sync-operational-route.js';
import {
  pluggyWebhookBodyLimitBytes,
  processPluggyWebhookBody,
  type PluggyWebhookRouteDependencies,
} from './webhook-route.js';
import { requirePluggyWebhookCredential } from './webhook-auth.js';

export interface ApiServerDependencies extends PluggyWebhookRouteDependencies {
  mcpToken: string;
  nodeEnvironment: 'development' | 'production' | 'test';
  readiness?: () => Promise<boolean>;
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

export function createApiServer(dependencies: ApiServerDependencies): FastifyInstance {
  if (
    dependencies.operational !== undefined &&
    dependencies.operational.workspaceId !== dependencies.workspaceId
  ) {
    throw new TypeError('API route dependencies must use the configured workspace.');
  }
  const credentials = [
    dependencies.webhookSecret,
    dependencies.mcpToken,
    ...(dependencies.operational === undefined ? [] : [dependencies.operational.webToken]),
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
