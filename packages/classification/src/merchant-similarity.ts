export const merchantResolutionPolicyVersion = 'merchant-resolution-v1' as const;
export const merchantPatternAutoMatchThreshold = '0.9500' as const;
export const merchantFuzzyReviewThreshold = '0.5000' as const;

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function bigrams(value: string): Set<string> {
  const characters = [...value.replace(/\s+/gu, ' ').trim()];
  if (characters.length < 2) return new Set(characters);
  return new Set(
    characters.slice(0, -1).map((character, index) => character + characters[index + 1]),
  );
}

function bigramSimilarity(left: string, right: string): number {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0;
  const intersection = [...leftBigrams].filter((bigram) => rightBigrams.has(bigram)).length;
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

export function merchantCandidateSimilarity(left: string, right: string): string {
  if (left === right && left.length > 0) return '1.0000';
  return Math.max(tokenSimilarity(left, right), bigramSimilarity(left, right)).toFixed(4);
}
