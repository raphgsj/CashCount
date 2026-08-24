export const descriptionNormalizationPolicyVersion = 'description-normalization-v1' as const;

export type PaymentProcessorPrefix = 'MP';
export type TransactionReferenceKind = 'AUTHORIZATION' | 'DOCUMENT' | 'NSU';

export interface InstallmentDescriptionMetadata {
  current: number;
  raw: string;
  total: number;
}

export interface LocationOrStoreSuffix {
  kind: 'NUMERIC_STORE_CODE';
  value: string;
}

export interface TransactionReference {
  kind: TransactionReferenceKind;
  raw: string;
  value: string;
}

export interface DescriptionNormalizationResult {
  installment: InstallmentDescriptionMetadata | null;
  locationOrStoreSuffix: LocationOrStoreSuffix | null;
  normalized: string;
  original: string;
  policyVersion: typeof descriptionNormalizationPolicyVersion;
  processorPrefix: PaymentProcessorPrefix | null;
  tokens: readonly string[];
  transactionReferences: readonly TransactionReference[];
}

interface ReferencePattern {
  kind: TransactionReferenceKind;
  pattern: RegExp;
}

const installmentPattern =
  /\b(?:parc|parcela|parcelado)\.?\s*(\d{1,3})\s*(?:\/|de)\s*(\d{1,3})\b/iu;
const mercadoPagoPrefixPattern = /^\s*mp\s*\*\s*(?=[\p{L}\p{N}])/iu;
const referencePatterns: readonly ReferencePattern[] = [
  {
    kind: 'AUTHORIZATION',
    pattern:
      /\b(?:aut|auth|autorizacao|autorização)\s*[:#-]?\s*((?=[a-z0-9]{4,32}\b)(?=[a-z0-9]*\d)[a-z0-9]+)\b/iu,
  },
  {
    kind: 'DOCUMENT',
    pattern: /\bdoc\s*[:#-]?\s*((?=[a-z0-9]{4,32}\b)(?=[a-z0-9]*\d)[a-z0-9]+)\b/iu,
  },
  {
    kind: 'NSU',
    pattern: /\bnsu\s*[:#-]?\s*((?=[a-z0-9]{4,32}\b)(?=[a-z0-9]*\d)[a-z0-9]+)\b/iu,
  },
];
const tokenPattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function removeMatch(value: string, match: RegExpExecArray): string {
  return `${value.slice(0, match.index)} ${value.slice(match.index + match[0].length)}`;
}

function normalizePunctuation(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}&+'’-]+/gu, ' ')
    .replace(/(^|\s)['’-]+(?=\s|$)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function tokens(value: string): readonly string[] {
  return Object.freeze(value.match(tokenPattern) ?? []);
}

function extractInstallment(value: string): {
  metadata: InstallmentDescriptionMetadata | null;
  remaining: string;
} {
  const match = installmentPattern.exec(value);
  if (match === null) return { metadata: null, remaining: value };
  const currentText = match[1];
  const totalText = match[2];
  if (currentText === undefined || totalText === undefined) {
    return { metadata: null, remaining: value };
  }
  const current = Number.parseInt(currentText, 10);
  const total = Number.parseInt(totalText, 10);
  if (current < 1 || total < current) return { metadata: null, remaining: value };

  return {
    metadata: Object.freeze({ current, raw: match[0], total }),
    remaining: removeMatch(value, match),
  };
}

function extractReferences(value: string): {
  references: readonly TransactionReference[];
  remaining: string;
} {
  let remaining = value;
  const references: TransactionReference[] = [];
  for (const { kind, pattern } of referencePatterns) {
    const match = pattern.exec(remaining);
    const matchedValue = match?.[1];
    if (match === null || matchedValue === undefined) continue;
    references.push(Object.freeze({ kind, raw: match[0], value: matchedValue.toUpperCase() }));
    remaining = removeMatch(remaining, match);
  }
  return { references: Object.freeze(references), remaining };
}

function extractLocationOrStoreSuffix(value: string): {
  metadata: LocationOrStoreSuffix | null;
  remaining: string;
} {
  const valueTokens = tokens(value);
  const suffix = valueTokens.at(-1);
  const merchantTokens = valueTokens.slice(0, -1);
  if (
    suffix === undefined ||
    !/^\d{3,8}$/u.test(suffix) ||
    merchantTokens.filter((token) => /\p{L}/u.test(token)).length < 2
  ) {
    return { metadata: null, remaining: value };
  }

  const suffixIndex = value.lastIndexOf(suffix);
  return {
    metadata: Object.freeze({ kind: 'NUMERIC_STORE_CODE', value: suffix }),
    remaining: value.slice(0, suffixIndex).trim(),
  };
}

export function normalizeTransactionDescription(original: string): DescriptionNormalizationResult {
  let working = original.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  let processorPrefix: PaymentProcessorPrefix | null = null;
  const prefixMatch = mercadoPagoPrefixPattern.exec(working);
  if (prefixMatch !== null) {
    processorPrefix = 'MP';
    working = removeMatch(working, prefixMatch);
  }

  const installmentResult = extractInstallment(working);
  const referenceResult = extractReferences(installmentResult.remaining);
  const punctuationNormalized = normalizePunctuation(referenceResult.remaining);
  const suffixResult = extractLocationOrStoreSuffix(punctuationNormalized);
  const normalized = suffixResult.remaining;

  return Object.freeze({
    installment: installmentResult.metadata,
    locationOrStoreSuffix: suffixResult.metadata,
    normalized,
    original,
    policyVersion: descriptionNormalizationPolicyVersion,
    processorPrefix,
    tokens: tokens(normalized),
    transactionReferences: referenceResult.references,
  });
}
