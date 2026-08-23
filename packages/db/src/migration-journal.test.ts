import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultMigrationsFolder } from './migrations.js';

interface MigrationJournal {
  entries: readonly {
    idx: number;
    tag: string;
    when: number;
  }[];
}

describe('migration journal', () => {
  it('keeps migration indexes and timestamps strictly increasing', async () => {
    const journal = JSON.parse(
      await readFile(join(defaultMigrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as MigrationJournal;

    for (const [index, entry] of journal.entries.entries()) {
      expect(entry.idx).toBe(index);
      await expect(
        access(join(defaultMigrationsFolder, `${entry.tag}.sql`)),
      ).resolves.toBeUndefined();

      if (index > 0) {
        const previousEntry = journal.entries[index - 1];

        if (previousEntry === undefined) {
          throw new Error('Migration journal entry ordering is inconsistent.');
        }

        expect(entry.when).toBeGreaterThan(previousEntry.when);
      }
    }
  });
});
