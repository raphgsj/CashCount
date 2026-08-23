import { parseWebConfig } from '@cashcount/config';

export const applicationName = '@cashcount/web' as const;
export const config = parseWebConfig(process.env);
