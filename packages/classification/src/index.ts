export const packageName = '@cashcount/classification' as const;

export {
  descriptionNormalizationPolicyVersion,
  normalizeTransactionDescription,
  type DescriptionNormalizationResult,
  type InstallmentDescriptionMetadata,
  type LocationOrStoreSuffix,
  type PaymentProcessorPrefix,
  type TransactionReference,
  type TransactionReferenceKind,
} from './description-normalizer.js';
export {
  merchantCandidateSimilarity,
  merchantFuzzyReviewThreshold,
  merchantPatternAutoMatchThreshold,
  merchantResolutionPolicyVersion,
} from './merchant-similarity.js';
