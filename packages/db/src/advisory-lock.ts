import type { Pool, PoolClient } from 'pg';

type LockedOutcome<Result> =
  { error: unknown; succeeded: false } | { succeeded: true; value: Result };

async function runAndUnlock<Result>(
  client: PoolClient,
  lockKey: string,
  action: () => Promise<Result>,
): Promise<Result> {
  let outcome: LockedOutcome<Result>;
  try {
    outcome = { succeeded: true, value: await action() };
  } catch (error) {
    outcome = { error, succeeded: false };
  }
  try {
    await client.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);
    client.release();
  } catch (error) {
    client.release(error instanceof Error ? error : new Error('Advisory unlock failed.'));
    throw error;
  }
  if (!outcome.succeeded) throw outcome.error;
  return outcome.value;
}

export async function withAdvisoryLock<Result>(
  pool: Pool,
  lockKey: string,
  action: () => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
  } catch (error) {
    client.release(error instanceof Error ? error : new Error('Advisory lock failed.'));
    throw error;
  }
  return runAndUnlock(client, lockKey, action);
}

export type TryAdvisoryLockResult<Result> = { acquired: false } | { acquired: true; value: Result };

export async function tryWithAdvisoryLock<Result>(
  pool: Pool,
  lockKey: string,
  action: () => Promise<Result>,
): Promise<TryAdvisoryLockResult<Result>> {
  const client = await pool.connect();
  let acquired: boolean;
  try {
    const result = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired`,
      [lockKey],
    );
    acquired = result.rows[0]?.acquired ?? false;
  } catch (error) {
    client.release(error instanceof Error ? error : new Error('Advisory lock failed.'));
    throw error;
  }
  if (!acquired) {
    client.release();
    return { acquired: false };
  }
  return { acquired: true, value: await runAndUnlock(client, lockKey, action) };
}

export function providerConnectionLockKey(
  workspaceId: string,
  externalConnectionId: string,
): string {
  return `provider-connection-sync:${workspaceId}:${externalConnectionId}`;
}
