import { describe, expect, it } from 'vitest';

import {
  merchantCandidateSimilarity,
  merchantFuzzyReviewThreshold,
  merchantPatternAutoMatchThreshold,
  merchantResolutionPolicyVersion,
} from './merchant-similarity.js';

describe('merchant candidate similarity', () => {
  it('is versioned and keeps automatic pattern matching stricter than fuzzy review', () => {
    expect(merchantResolutionPolicyVersion).toBe('merchant-resolution-v1');
    expect(merchantPatternAutoMatchThreshold > merchantFuzzyReviewThreshold).toBe(true);
  });

  it.each([
    ['starbucks', 'starbucks', '1.0000'],
    ['starbucks', 'starbuks', '0.8000'],
    ['mercado central', 'mercado central loja', '0.8485'],
    ['padaria sol', 'posto lua', '0.0000'],
    ['', '', '0.0000'],
  ])('scores %s against %s deterministically', (left, right, expected) => {
    expect(merchantCandidateSimilarity(left, right)).toBe(expected);
    expect(merchantCandidateSimilarity(left, right)).toBe(merchantCandidateSimilarity(right, left));
  });
});
