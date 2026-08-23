import { createDatabaseClient } from './client.js';
import { appUser, workspace, workspaceMember } from './schema.js';

export const syntheticIdentitySeed = {
  user: {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'owner@example.test',
    displayName: 'Synthetic Owner',
    authProvider: 'synthetic',
    authSubject: 'synthetic-owner',
    status: 'ACTIVE',
  },
  workspace: {
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Synthetic Personal Finance',
    baseCurrency: 'BRL',
    timezone: 'America/Sao_Paulo',
    analyticsPolicyVersion: 1,
  },
} as const;

export async function seedSyntheticIdentity(
  connectionString: string,
  nodeEnvironment: 'development' | 'test' | 'production',
): Promise<void> {
  if (nodeEnvironment === 'production') {
    throw new Error('Synthetic database seeding is disabled in production.');
  }

  const { database, pool } = createDatabaseClient(connectionString);

  try {
    await database.transaction(async (transaction) => {
      await transaction.insert(appUser).values(syntheticIdentitySeed.user).onConflictDoNothing();
      await transaction
        .insert(workspace)
        .values(syntheticIdentitySeed.workspace)
        .onConflictDoNothing();
      await transaction
        .insert(workspaceMember)
        .values({
          workspaceId: syntheticIdentitySeed.workspace.id,
          userId: syntheticIdentitySeed.user.id,
          role: 'OWNER',
        })
        .onConflictDoNothing();
    });
  } finally {
    await pool.end();
  }
}
