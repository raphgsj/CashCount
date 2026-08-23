import { parseWorkerConfig } from '@cashcount/config';

export const applicationName = '@cashcount/worker' as const;
export const config = parseWorkerConfig(process.env);
