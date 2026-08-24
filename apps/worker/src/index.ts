import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { parseWorkerConfig } from '@cashcount/config';
import { createDatabaseClient, JobQueueRepository } from '@cashcount/db';

import { PersistentQueueWorker } from './queue-worker.js';
import { runUntilTermination } from './worker-process.js';

export const applicationName = '@cashcount/worker' as const;
export const config = parseWorkerConfig(process.env);

const databaseUrl = config.DATABASE_URL ?? config.LOCAL_DATABASE_URL;
if (databaseUrl === undefined) throw new Error('Worker database configuration is unavailable.');

const databaseClient = createDatabaseClient(databaseUrl);
const worker = new PersistentQueueWorker({
  handlers: {},
  onOperationalEvent: (event) => console.error(JSON.stringify(event)),
  queue: new JobQueueRepository(databaseClient.pool),
  workerId: `${hostname()}:${process.pid}:${randomUUID()}`,
});

console.log(`${applicationName} started; registered_job_types=0`);
try {
  await runUntilTermination(worker);
} finally {
  await databaseClient.pool.end();
  console.log(`${applicationName} stopped`);
}
