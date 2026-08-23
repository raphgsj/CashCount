import { parseDatabaseConfig } from '@cashcount/config';

import { seedSyntheticIdentity } from './seed.js';

const config = parseDatabaseConfig(process.env);

await seedSyntheticIdentity(config.databaseUrl, config.nodeEnvironment);
