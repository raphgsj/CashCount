export const pluggyFixtureIds = {
  account: '22222222-2222-4222-8222-222222222222',
  bill: '44444444-4444-4444-8444-444444444444',
  charge: '66666666-6666-4666-8666-666666666666',
  connection: '11111111-1111-4111-8111-111111111111',
  historyFirst: '77777777-7777-4777-8777-777777777777',
  historyLast: '88888888-8888-4888-8888-888888888888',
  payment: '55555555-5555-4555-8555-555555555555',
  replacementPredecessor: '99999999-9999-4999-8999-999999999999',
  replacementSuccessor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;

export const pluggyAccountBody = `{
  "id":"${pluggyFixtureIds.account}",
  "itemId":"${pluggyFixtureIds.connection}",
  "type":"CREDIT",
  "subtype":"CREDIT_CARD",
  "number":"0042",
  "name":"Synthetic fixture card",
  "balance":1250.400000,
  "currencyCode":"BRL",
  "creditData":{
    "balanceCloseDate":"2026-08-10",
    "balanceDueDate":"2026-08-17",
    "availableCreditLimit":3749.600000,
    "creditLimit":5000.000000,
    "status":"ACTIVE"
  },
  "updatedAt":"2026-08-23T12:00:00.000Z"
}`;

export const pluggyItemLifecycleFixtures = [
  {
    expectedLocalStatus: 'ACTIVE',
    name: 'successful update',
    responseBody: itemBody('UPDATED', 'SUCCESS', null),
  },
  {
    expectedLocalStatus: 'ACTIVE',
    name: 'partial update retains usable data',
    responseBody: itemBody('UPDATED', 'PARTIAL_SUCCESS', 'ACCOUNT_NEEDS_ATTENTION'),
  },
  {
    expectedLocalStatus: 'SYNCING',
    name: 'account synchronization in progress',
    responseBody: itemBody('UPDATING', 'ACCOUNTS_IN_PROGRESS', null),
  },
  {
    expectedLocalStatus: 'USER_INPUT_REQUIRED',
    name: 'provider requests user input',
    responseBody: itemBody('WAITING_USER_INPUT', 'WAITING_USER_INPUT', null),
  },
  {
    expectedLocalStatus: 'USER_ACTION_REQUIRED',
    name: 'provider waits for authorization',
    responseBody: itemBody('UPDATING', 'USER_AUTHORIZATION_PENDING', null),
  },
  {
    expectedLocalStatus: 'REAUTH_REQUIRED',
    name: 'credentials became invalid',
    responseBody: itemBody('LOGIN_ERROR', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS'),
  },
  {
    expectedLocalStatus: 'REAUTH_REQUIRED',
    name: 'authorization was revoked',
    responseBody: itemBody('OUTDATED', 'USER_AUTHORIZATION_REVOKED', 'CONSENT_REVOKED'),
  },
  {
    expectedLocalStatus: 'PROVIDER_ERROR',
    name: 'unclassified provider failure stays explicit',
    responseBody: itemBody('UNEXPECTED_ERROR', 'ERROR', 'UNEXPECTED_ERROR'),
  },
] as const;

function itemBody(status: string, executionStatus: string, errorCode: null | string): string {
  return `{
    "id":"${pluggyFixtureIds.connection}",
    "connector":{"id":601,"name":"Synthetic Fixture Bank"},
    "status":"${status}",
    "executionStatus":"${executionStatus}",
    "lastUpdatedAt":"2026-08-23T12:00:00.000Z",
    "updatedAt":"2026-08-23T12:00:00.000Z",
    "consentExpiresAt":"2026-11-23T12:00:00.000Z",
    "error":${errorCode === null ? 'null' : `{"code":"${errorCode}"}`}
  }`;
}

const transactionRows = [
  `{
    "id":"30000000-0000-4000-8000-000000000001",
    "accountId":"${pluggyFixtureIds.account}",
    "status":"POSTED","type":"DEBIT","amount":89.900000,
    "amountInAccountCurrency":89.900000,"currencyCode":"BRL",
    "date":"2026-08-20T10:00:00-03:00","description":"Synthetic purchase",
    "descriptionRaw":"SYNTHETIC PURCHASE","providerCode":"A1","providerId":"P1",
    "operationType":"PURCHASE","operationTypeAdditionalInfo":null,
    "categoryId":"synthetic-food","category":"Food",
    "merchant":{"name":"Fixture Cafe","businessName":null},
    "creditCardMetadata":null
  }`,
  `{
    "id":"30000000-0000-4000-8000-000000000002",
    "accountId":"${pluggyFixtureIds.account}",
    "status":"POSTED","type":"CREDIT","amount":-20.100000,
    "amountInAccountCurrency":-20.100000,"currencyCode":"BRL",
    "date":"2026-08-21T11:00:00-03:00","description":"Synthetic unresolved credit",
    "descriptionRaw":null,"providerCode":null,"providerId":null,
    "operationType":null,"operationTypeAdditionalInfo":null,
    "categoryId":null,"category":null,"merchant":null,"creditCardMetadata":null
  }`,
  `{
    "id":"30000000-0000-4000-8000-000000000003",
    "accountId":"${pluggyFixtureIds.account}",
    "status":"PENDING","type":"DEBIT","amount":12.345678,
    "amountInAccountCurrency":67.890123,"currencyCode":"USD",
    "date":"2026-08-22T12:00:00Z","description":"Synthetic foreign purchase",
    "descriptionRaw":null,"providerCode":null,"providerId":null,
    "operationType":null,"operationTypeAdditionalInfo":null,
    "categoryId":null,"category":null,"merchant":null,
    "creditCardMetadata":{"installmentNumber":2,"totalInstallments":10,
      "totalAmount":123.456789,"purchaseDate":"2026-08-20T12:00:00Z",
      "payeeMCC":5812,"cardNumber":"0099","billId":"${pluggyFixtureIds.bill}",
      "billForecastDate":"2026-09","feeType":null,"feeTypeAdditionalInfo":null,
      "otherCreditsType":null,"otherCreditsAdditionalInfo":null}
  }`,
  `{
    "id":"30000000-0000-4000-8000-000000000004",
    "accountId":"${pluggyFixtureIds.account}",
    "status":null,"type":null,"amount":0.000001,
    "amountInAccountCurrency":null,"currencyCode":"EUR",
    "date":"2026-08-22T13:00:00Z","description":"Synthetic missing enrichment",
    "descriptionRaw":null,"providerCode":null,"providerId":null,
    "operationType":null,"operationTypeAdditionalInfo":null,
    "categoryId":null,"category":null,"merchant":null,"creditCardMetadata":null
  }`,
] as const;

export const pluggyTransactionMatrixBody = `{"results":[${transactionRows.join(',')}],"next":null}`;

export const pluggyTransactionMatrixExpected = [
  {
    amountInAccountCurrencySigned: '89.9',
    amountSigned: '89.9',
    currency: 'BRL',
    merchantName: 'Fixture Cafe',
    providerType: 'DEBIT',
  },
  {
    amountInAccountCurrencySigned: '-20.1',
    amountSigned: '-20.1',
    currency: 'BRL',
    merchantName: null,
    providerType: 'CREDIT',
  },
  {
    amountInAccountCurrencySigned: '67.890123',
    amountSigned: '12.345678',
    currency: 'USD',
    merchantName: null,
    providerType: 'DEBIT',
  },
  {
    amountInAccountCurrencySigned: null,
    amountSigned: '0.000001',
    currency: 'EUR',
    merchantName: null,
    providerType: null,
  },
] as const;

export const pluggyBillsBody = `{
  "results":[{
    "id":"${pluggyFixtureIds.bill}",
    "dueDate":"2026-09-17T00:00:00.000Z",
    "billClosingDate":"2026-09-10T00:00:00.000Z",
    "totalAmount":1250.400000,"totalAmountCurrencyCode":"BRL",
    "minimumPaymentAmount":null,"allowsInstallments":true,
    "payments":[{"id":"${pluggyFixtureIds.payment}","valueType":"FULL_PAYMENT",
      "paymentDate":"2026-08-17T00:00:00.000Z","paymentMode":null,
      "amount":1200.000000,"currencyCode":"BRL"}],
    "financeCharges":[{"id":"${pluggyFixtureIds.charge}","type":"IOF",
      "amount":50.400000,"currencyCode":"BRL","additionalInfo":null}]
  }]
}`;

export const pluggyHistoryPages = [
  {
    expectedCoverage: 'PARTIAL',
    expectedObservedDate: '2026-08-23',
    responseBody: `{"results":[${historyTransaction(
      pluggyFixtureIds.historyFirst,
      '2026-08-23T10:00:00Z',
    )}],"next":"?accountId=${pluggyFixtureIds.account}&after=synthetic-cursor"}`,
  },
  {
    expectedCoverage: 'PROVIDER_MAXIMUM_RETRIEVED',
    expectedObservedDate: '2024-08-23',
    responseBody: `{"results":[${historyTransaction(
      pluggyFixtureIds.historyLast,
      '2024-08-23T10:00:00Z',
    )}],"next":null}`,
  },
] as const;

function historyTransaction(id: string, date: string): string {
  return `{"id":"${id}","accountId":"${pluggyFixtureIds.account}",
    "status":"POSTED","type":"DEBIT","amount":1.000000,
    "amountInAccountCurrency":1.000000,"currencyCode":"BRL","date":"${date}",
    "description":"Synthetic history marker","descriptionRaw":null,"providerCode":null,
    "providerId":null,"operationType":null,"operationTypeAdditionalInfo":null,
    "categoryId":null,"category":null,"merchant":null,"creditCardMetadata":null}`;
}

export const pluggyReplacementFixture = {
  createdWebhookHint: {
    accountId: pluggyFixtureIds.account,
    createdTransactionsLink: `https://api.pluggy.ai/transactions?accountId=${pluggyFixtureIds.account}&createdAtFrom=2026-08-23T12%3A00%3A00.000Z`,
    createdTransactionsLinkV2: `https://api.pluggy.ai/v2/transactions?accountId=${pluggyFixtureIds.account}&createdAtFrom=2026-08-23T12%3A00%3A00.000Z&after=replacement-cursor`,
    transactionsCreatedAtFrom: '2026-08-23T12:00:00.000Z',
  },
  deletedWebhookBody: `{"event":"transactions/deleted","itemId":"${pluggyFixtureIds.connection}",
    "accountId":"${pluggyFixtureIds.account}",
    "transactionIds":["${pluggyFixtureIds.replacementPredecessor}"]}`,
  predecessorBody: replacementTransaction(pluggyFixtureIds.replacementPredecessor),
  successorBody: replacementTransaction(pluggyFixtureIds.replacementSuccessor),
} as const;

function replacementTransaction(id: string): string {
  return `{"id":"${id}","accountId":"${pluggyFixtureIds.account}","status":"POSTED",
    "type":"DEBIT","amount":42.420000,"amountInAccountCurrency":42.420000,
    "currencyCode":"BRL","date":"2026-08-23T09:00:00-03:00",
    "description":"Synthetic replacement candidate","descriptionRaw":null,
    "providerCode":null,"providerId":null,"operationType":null,
    "operationTypeAdditionalInfo":null,"categoryId":null,"category":null,
    "merchant":null,"creditCardMetadata":null}`;
}
