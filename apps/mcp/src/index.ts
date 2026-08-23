import { parseMcpConfig } from '@cashcount/config';

export const applicationName = '@cashcount/mcp' as const;
export const config = parseMcpConfig(process.env);
