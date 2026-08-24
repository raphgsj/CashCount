import { describe, expect, it } from 'vitest';

import {
  descriptionNormalizationPolicyVersion,
  normalizeTransactionDescription,
  type DescriptionNormalizationResult,
} from './description-normalizer.js';

interface DescriptionFixture {
  expected: Partial<DescriptionNormalizationResult>;
  name: string;
  original: string;
}

const fixtures: readonly DescriptionFixture[] = [
  {
    expected: {
      locationOrStoreSuffix: { kind: 'NUMERIC_STORE_CODE', value: '00392' },
      normalized: 'stbks brasil',
      processorPrefix: 'MP',
      tokens: ['stbks', 'brasil'],
    },
    name: 'documented processor and store suffix example',
    original: 'MP *STBKS BRASIL 00392',
  },
  {
    expected: {
      normalized: 'café são paulo',
      tokens: ['café', 'são', 'paulo'],
    },
    name: 'Unicode compatibility and whitespace',
    original: '  ＣＡＦÉ\u00a0  SÃO\nPAULO  ',
  },
  {
    expected: {
      normalized: "h&m + café-d'avó",
      tokens: ['h', 'm', "café-d'avó"],
    },
    name: 'meaningful punctuation',
    original: "H&M + Café-D'Avó",
  },
  {
    expected: {
      installment: { current: 2, raw: 'PARC 02/10', total: 10 },
      normalized: 'loja exemplo',
      tokens: ['loja', 'exemplo'],
      transactionReferences: [{ kind: 'NSU', raw: 'NSU: A1B2C3', value: 'A1B2C3' }],
    },
    name: 'installment and transaction reference metadata',
    original: 'LOJA EXEMPLO PARC 02/10 NSU: A1B2C3',
  },
  {
    expected: {
      installment: null,
      normalized: 'loja exemplo parc 10 02',
    },
    name: 'invalid installment sequence remains merchant evidence',
    original: 'LOJA EXEMPLO PARC 10/02',
  },
  {
    expected: {
      normalized: 'mp serviços',
      processorPrefix: null,
    },
    name: 'processor letters without the exact marker',
    original: 'MP Serviços',
  },
  {
    expected: {
      locationOrStoreSuffix: null,
      normalized: 'canal 1000',
    },
    name: 'merchant-significant number',
    original: 'Canal 1000',
  },
  {
    expected: {
      locationOrStoreSuffix: { kind: 'NUMERIC_STORE_CODE', value: '0042' },
      normalized: 'mercado central',
    },
    name: 'likely numeric store code',
    original: 'Mercado Central #0042',
  },
  {
    expected: {
      normalized: '東京 市場',
      tokens: ['東京', '市場'],
    },
    name: 'non-Latin merchant text',
    original: '東京・市場',
  },
];

describe('transaction description normalizer', () => {
  it.each(fixtures)('$name', ({ expected, original }) => {
    expect(normalizeTransactionDescription(original)).toMatchObject(expected);
  });

  it('preserves the exact original while returning immutable deterministic output', () => {
    const original = '  Loja\u0000 Exemplo  ';
    const first = normalizeTransactionDescription(original);
    const second = normalizeTransactionDescription(original);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      normalized: 'loja exemplo',
      original,
      policyVersion: descriptionNormalizationPolicyVersion,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tokens)).toBe(true);
  });

  it('returns an empty matching key rather than inventing merchant evidence', () => {
    expect(normalizeTransactionDescription('\u0000\u200b')).toMatchObject({
      normalized: '',
      tokens: [],
    });
  });
});
