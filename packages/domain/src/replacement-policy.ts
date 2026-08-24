import { parseBankDate, type BankDate } from './dates.js';
import { parseCurrencyCode, parseDecimalString } from './money.js';

export const transactionReplacementPolicyVersion = 'REPLACEMENT_V1' as const;
export const transactionReplacementAutoConfirmThreshold = '0.9500' as const;
export const transactionReplacementDateWindowDays = 3 as const;

export interface ReplacementTransactionFacts {
  accountId: string;
  amountSigned: string;
  billForecastMonth: null | string;
  cardLastFour: null | string;
  currency: string;
  descriptionNormalized: string;
  installmentNumber: null | number;
  installmentTotal: null | number;
  localDate: string;
  payeeMcc: null | string;
  providerBillId: null | string;
  providerType: null | string;
}

export interface TransactionReplacementScore {
  dateDistanceDays: number;
  descriptionSimilarity: string;
  eligible: boolean;
  incompatibleFeature: string | null;
  policyVersion: typeof transactionReplacementPolicyVersion;
  score: string;
}

function dateDistance(left: BankDate, right: BankDate): number {
  const leftMs = new Date(`${left}T00:00:00.000Z`).getTime();
  const rightMs = new Date(`${right}T00:00:00.000Z`).getTime();
  return Math.abs(Math.round((leftMs - rightMs) / 86_400_000));
}

function tokenSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function conflictingOptional(left: null | number | string, right: null | number | string): boolean {
  return left !== null && right !== null && left !== right;
}

export function scoreTransactionReplacement(
  predecessor: ReplacementTransactionFacts,
  successor: ReplacementTransactionFacts,
): TransactionReplacementScore {
  const leftAmount = parseDecimalString(predecessor.amountSigned);
  const rightAmount = parseDecimalString(successor.amountSigned);
  const leftCurrency = parseCurrencyCode(predecessor.currency);
  const rightCurrency = parseCurrencyCode(successor.currency);
  const leftDate = parseBankDate(predecessor.localDate);
  const rightDate = parseBankDate(successor.localDate);
  const distance = dateDistance(leftDate, rightDate);
  const similarity = tokenSimilarity(
    predecessor.descriptionNormalized,
    successor.descriptionNormalized,
  );
  const incompatible = [
    ['account', predecessor.accountId !== successor.accountId],
    ['currency', leftCurrency !== rightCurrency],
    ['amount', leftAmount !== rightAmount],
    ['date', distance > transactionReplacementDateWindowDays],
    [
      'installmentNumber',
      conflictingOptional(predecessor.installmentNumber, successor.installmentNumber),
    ],
    [
      'installmentTotal',
      conflictingOptional(predecessor.installmentTotal, successor.installmentTotal),
    ],
    [
      'billForecastMonth',
      conflictingOptional(predecessor.billForecastMonth, successor.billForecastMonth),
    ],
    ['providerBillId', conflictingOptional(predecessor.providerBillId, successor.providerBillId)],
    ['cardLastFour', conflictingOptional(predecessor.cardLastFour, successor.cardLastFour)],
    ['payeeMcc', conflictingOptional(predecessor.payeeMcc, successor.payeeMcc)],
  ].find((entry) => entry[1] === true)?.[0] as string | undefined;
  if (incompatible !== undefined) {
    return {
      dateDistanceDays: distance,
      descriptionSimilarity: similarity.toFixed(4),
      eligible: false,
      incompatibleFeature: incompatible,
      policyVersion: transactionReplacementPolicyVersion,
      score: '0.0000',
    };
  }

  const dateScore = [0.2, 0.175, 0.15, 0.125][distance] ?? 0;
  const descriptionScore = similarity * 0.25;
  const providerTypeScore =
    predecessor.providerType !== null && successor.providerType !== null
      ? predecessor.providerType === successor.providerType
        ? 0.05
        : 0
      : 0.05;
  const score = 0.4 + dateScore + descriptionScore + providerTypeScore + 0.1;
  return {
    dateDistanceDays: distance,
    descriptionSimilarity: similarity.toFixed(4),
    eligible: true,
    incompatibleFeature: null,
    policyVersion: transactionReplacementPolicyVersion,
    score: Math.min(1, score).toFixed(4),
  };
}
