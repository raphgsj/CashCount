import { Money } from './money.js';
import { parseBankDate, type BankDate } from './dates.js';
import type { AccountType, TransactionDirection } from './transaction-policy.js';

export const financialRoleDetectionPolicyVersion = 'financial-role-detection-v1' as const;
export const transferDetectionDateWindowDays = 2;
export const refundDetectionDateWindowDays = 120;

export interface FinancialRoleDetectionFacts {
  accountId: string;
  accountType: AccountType;
  amountSigned: string;
  currency: string;
  descriptionNormalized: string;
  direction: TransactionDirection;
  id: string;
  merchantId: string | null;
  transactionLocalDate: string;
}

export interface DetectionCandidate {
  candidateId: string;
  dateDistanceDays: number;
}

export interface PairDetectionResult {
  candidates: readonly DetectionCandidate[];
  matchedTransactionId: string | null;
  policyVersion: typeof financialRoleDetectionPolicyVersion;
  status: 'AUTO_CONFIRMED' | 'NEEDS_REVIEW' | 'NONE';
}

export interface BillPaymentEvidence {
  activeBankReconciliationId?: string | null;
  matchedCardPaymentChildId?: string | null;
}

export interface BillPaymentDetectionResult {
  evidenceReference: string | null;
  policyVersion: typeof financialRoleDetectionPolicyVersion;
  role: 'CARD_BILL_PAYMENT' | null;
  status: 'CONFIRMED' | 'NONE';
}

const transferTokens = new Set(['doc', 'pix', 'ted', 'transfer', 'transferencia', 'transferência']);
const refundTokens = new Set(['devolucao', 'devolução', 'estorno', 'reembolso', 'refund']);
const depositAccountTypes: ReadonlySet<AccountType> = new Set(['CHECKING', 'SAVINGS']);

function tokens(value: string): string[] {
  return value.split(' ').filter((token) => token.length > 0);
}

function containsToken(value: string, expected: ReadonlySet<string>): boolean {
  return tokens(value).some((token) => expected.has(token));
}

function dateOrdinal(value: string): number {
  const parsed: BankDate = parseBankDate(value);
  return Math.trunc(Date.parse(`${parsed}T00:00:00.000Z`) / 86_400_000);
}

function dateDistance(left: string, right: string): number {
  return Math.abs(dateOrdinal(left) - dateOrdinal(right));
}

function amountWithinTolerance(
  left: FinancialRoleDetectionFacts,
  right: FinancialRoleDetectionFacts,
  toleranceAmount: string,
): boolean {
  if (left.currency !== right.currency) return false;
  const leftAmount = Money.from(left.amountSigned, left.currency).abs();
  const rightAmount = Money.from(right.amountSigned, right.currency).abs();
  const tolerance = Money.from(toleranceAmount, left.currency);
  if (tolerance.isNegative()) throw new RangeError('Detection tolerance cannot be negative.');
  return leftAmount.subtract(rightAmount).abs().compare(tolerance) <= 0;
}

function oppositeDirections(left: TransactionDirection, right: TransactionDirection): boolean {
  return (left === 'INFLOW' && right === 'OUTFLOW') || (left === 'OUTFLOW' && right === 'INFLOW');
}

export function detectBillPaymentRole(
  transaction: FinancialRoleDetectionFacts,
  evidence: BillPaymentEvidence,
): BillPaymentDetectionResult {
  const cardReference = evidence.matchedCardPaymentChildId ?? null;
  const bankReference = evidence.activeBankReconciliationId ?? null;
  if (transaction.accountType === 'CREDIT_CARD' && cardReference !== null) {
    return {
      evidenceReference: cardReference,
      policyVersion: financialRoleDetectionPolicyVersion,
      role: 'CARD_BILL_PAYMENT',
      status: 'CONFIRMED',
    };
  }
  if (
    depositAccountTypes.has(transaction.accountType) &&
    transaction.direction === 'OUTFLOW' &&
    bankReference !== null
  ) {
    return {
      evidenceReference: bankReference,
      policyVersion: financialRoleDetectionPolicyVersion,
      role: 'CARD_BILL_PAYMENT',
      status: 'CONFIRMED',
    };
  }
  return {
    evidenceReference: null,
    policyVersion: financialRoleDetectionPolicyVersion,
    role: null,
    status: 'NONE',
  };
}

export function detectInternalTransfer(
  transaction: FinancialRoleDetectionFacts,
  possibleCounterparts: readonly FinancialRoleDetectionFacts[],
  toleranceAmount: string,
): PairDetectionResult {
  if (
    !depositAccountTypes.has(transaction.accountType) ||
    !containsToken(transaction.descriptionNormalized, transferTokens)
  ) {
    return {
      candidates: [],
      matchedTransactionId: null,
      policyVersion: financialRoleDetectionPolicyVersion,
      status: 'NONE',
    };
  }

  const candidates = possibleCounterparts
    .filter(
      (candidate) =>
        candidate.id !== transaction.id &&
        candidate.accountId !== transaction.accountId &&
        depositAccountTypes.has(candidate.accountType) &&
        containsToken(candidate.descriptionNormalized, transferTokens) &&
        oppositeDirections(transaction.direction, candidate.direction) &&
        dateDistance(transaction.transactionLocalDate, candidate.transactionLocalDate) <=
          transferDetectionDateWindowDays &&
        amountWithinTolerance(transaction, candidate, toleranceAmount),
    )
    .map((candidate) => ({
      candidateId: candidate.id,
      dateDistanceDays: dateDistance(
        transaction.transactionLocalDate,
        candidate.transactionLocalDate,
      ),
    }))
    .sort(
      (left, right) =>
        left.dateDistanceDays - right.dateDistanceDays ||
        (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0),
    );

  return {
    candidates,
    matchedTransactionId: candidates.length === 1 ? (candidates[0]?.candidateId ?? null) : null,
    policyVersion: financialRoleDetectionPolicyVersion,
    status:
      candidates.length === 1 ? 'AUTO_CONFIRMED' : candidates.length > 1 ? 'NEEDS_REVIEW' : 'NONE',
  };
}

function refundReference(value: string): string {
  return tokens(value)
    .filter((token) => !refundTokens.has(token))
    .join(' ');
}

export function detectRefund(
  transaction: FinancialRoleDetectionFacts,
  possiblePurchases: readonly FinancialRoleDetectionFacts[],
  toleranceAmount: string,
): PairDetectionResult {
  if (
    transaction.direction !== 'INFLOW' ||
    !containsToken(transaction.descriptionNormalized, refundTokens)
  ) {
    return {
      candidates: [],
      matchedTransactionId: null,
      policyVersion: financialRoleDetectionPolicyVersion,
      status: 'NONE',
    };
  }
  const targetAmount = Money.from(transaction.amountSigned, transaction.currency).abs();
  const reference = refundReference(transaction.descriptionNormalized);
  const candidates = possiblePurchases
    .filter((candidate) => {
      if (
        candidate.id === transaction.id ||
        candidate.accountId !== transaction.accountId ||
        candidate.direction !== 'OUTFLOW' ||
        candidate.currency !== transaction.currency
      ) {
        return false;
      }
      const distance =
        dateOrdinal(transaction.transactionLocalDate) - dateOrdinal(candidate.transactionLocalDate);
      if (distance < 0 || distance > refundDetectionDateWindowDays) return false;
      const candidateAmount = Money.from(candidate.amountSigned, candidate.currency).abs();
      if (targetAmount.compare(candidateAmount) > 0) return false;
      const referenceMatches =
        (transaction.merchantId !== null && transaction.merchantId === candidate.merchantId) ||
        (reference.length >= 3 && reference === candidate.descriptionNormalized);
      return referenceMatches && amountWithinTolerance(transaction, candidate, toleranceAmount);
    })
    .map((candidate) => ({
      candidateId: candidate.id,
      dateDistanceDays:
        dateOrdinal(transaction.transactionLocalDate) - dateOrdinal(candidate.transactionLocalDate),
    }))
    .sort(
      (left, right) =>
        left.dateDistanceDays - right.dateDistanceDays ||
        (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0),
    );

  return {
    candidates,
    matchedTransactionId: candidates.length === 1 ? (candidates[0]?.candidateId ?? null) : null,
    policyVersion: financialRoleDetectionPolicyVersion,
    status:
      candidates.length === 1 ? 'AUTO_CONFIRMED' : candidates.length > 1 ? 'NEEDS_REVIEW' : 'NONE',
  };
}
