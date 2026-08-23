import { parseApiConfig } from '@cashcount/config';

export const applicationName = '@cashcount/api' as const;
export const config = parseApiConfig(process.env);
