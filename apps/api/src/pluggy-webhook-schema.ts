import { z } from 'zod';

export const supportedPluggyWebhookEvents = [
  'item/created',
  'item/updated',
  'item/deleted',
  'item/error',
  'item/waiting_user_input',
  'item/waiting_user_action',
  'item/login_succeeded',
  'transactions/created',
  'transactions/updated',
  'transactions/deleted',
] as const;

const identifierSchema = z.string().uuid();
const commonFields = {
  clientUserId: z.string().min(1).max(500).optional(),
  eventId: identifierSchema,
  itemId: identifierSchema,
  triggeredBy: z.enum(['USER', 'CLIENT', 'SYNC', 'INTERNAL']).optional(),
};

function itemEventSchema(event: (typeof supportedPluggyWebhookEvents)[number]) {
  return z.object({ ...commonFields, event: z.literal(event) }).passthrough();
}

const itemErrorSchema = z
  .object({
    ...commonFields,
    error: z
      .object({
        code: z.string().min(1).max(200),
        message: z.string().min(1).max(1_000).optional(),
        parameter: z.string().min(1).max(200).optional(),
      })
      .passthrough(),
    event: z.literal('item/error'),
  })
  .passthrough();

const transactionCommonFields = {
  ...commonFields,
  accountId: identifierSchema,
  transactionsCount: z.number().int().min(0).max(1_000),
};

const transactionsCreatedSchema = z
  .object({
    ...transactionCommonFields,
    createdTransactionsLink: z.string().url().max(4_096).optional(),
    createdTransactionsLinkV2: z.string().url().max(4_096).optional(),
    event: z.literal('transactions/created'),
    transactionsCreatedAtFrom: z.string().datetime({ offset: true }).optional(),
    transactionsMinDate: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough()
  .refine(
    (payload) =>
      payload.createdTransactionsLink !== undefined ||
      payload.createdTransactionsLinkV2 !== undefined,
    { message: 'a documented transactions link is required' },
  );

function transactionIdsSchema(event: 'transactions/updated' | 'transactions/deleted', max: number) {
  return z
    .object({
      ...transactionCommonFields,
      event: z.literal(event),
      transactionIds: z.array(identifierSchema).min(1).max(max),
    })
    .passthrough()
    .refine((payload) => payload.transactionIds.length === payload.transactionsCount, {
      message: 'transactionsCount must equal transactionIds length',
    });
}

export const pluggyWebhookPayloadSchema = z.discriminatedUnion('event', [
  itemEventSchema('item/created'),
  itemEventSchema('item/updated'),
  itemEventSchema('item/deleted'),
  itemErrorSchema,
  itemEventSchema('item/waiting_user_input'),
  itemEventSchema('item/waiting_user_action'),
  itemEventSchema('item/login_succeeded'),
  transactionsCreatedSchema,
  transactionIdsSchema('transactions/updated', 400),
  transactionIdsSchema('transactions/deleted', 1_000),
]);

export type PluggyWebhookPayload = z.output<typeof pluggyWebhookPayloadSchema>;
