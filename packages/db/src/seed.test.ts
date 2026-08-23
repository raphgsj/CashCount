import { describe, expect, it } from 'vitest';

import { seedSyntheticIdentity } from './seed.js';

describe('synthetic identity seed', () => {
  it('refuses to run in production before opening a database connection', async () => {
    await expect(
      seedSyntheticIdentity(
        'postgresql://cashcount:unused@database.invalid:5432/cashcount',
        'production',
      ),
    ).rejects.toThrow('Synthetic database seeding is disabled in production.');
  });
});
