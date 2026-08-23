import { pluggyLifecycleMappingFixtures } from '@cashcount/test-fixtures';
import { describe, expect, it } from 'vitest';

import { mapPluggyItemLifecycle } from './lifecycle-mapper.js';

describe('mapPluggyItemLifecycle', () => {
  it.each(pluggyLifecycleMappingFixtures)('maps $name to $expectedLocalStatus', (fixture) => {
    expect(
      mapPluggyItemLifecycle({
        errorCode: fixture.errorCode,
        event: fixture.event,
        executionStatus: fixture.executionStatus,
        itemStatus: fixture.itemStatus,
      }),
    ).toBe(fixture.expectedLocalStatus);
  });

  it('gives terminal credential evidence precedence over a stale success snapshot', () => {
    expect(
      mapPluggyItemLifecycle({
        errorCode: 'USER_AUTHORIZATION_REVOKED',
        event: 'item/error',
        executionStatus: 'SUCCESS',
        itemStatus: 'UPDATED',
      }),
    ).toBe('REAUTH_REQUIRED');
  });

  it('gives deletion precedence over every retained snapshot field', () => {
    expect(
      mapPluggyItemLifecycle({
        errorCode: null,
        event: 'item/deleted',
        executionStatus: 'SUCCESS',
        itemStatus: 'UPDATED',
      }),
    ).toBe('DELETED');
  });

  it('does not let an unknown event override a valid current snapshot', () => {
    expect(
      mapPluggyItemLifecycle({
        errorCode: null,
        event: 'item/future_event',
        executionStatus: 'SUCCESS',
        itemStatus: 'UPDATED',
      }),
    ).toBe('ACTIVE');
  });
});
