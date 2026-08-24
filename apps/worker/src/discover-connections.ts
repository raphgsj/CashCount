import type { ProviderConnectionDto } from '@cashcount/provider-core';

const workspaceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ConnectionDiscoveryProvider {
  listConnections(): Promise<ProviderConnectionDto[]>;
}

export interface ConnectionDiscoveryRepository {
  assignDiscoveredConnections(
    workspaceId: string,
    connections: readonly ProviderConnectionDto[],
  ): Promise<readonly unknown[]>;
  workspaceExists(workspaceId: string): Promise<boolean>;
}

export interface DiscoverConnectionsOptions {
  provider: ConnectionDiscoveryProvider;
  repository: ConnectionDiscoveryRepository;
  workspaceId: string;
  writeLine: (line: string) => void;
}

export interface ConnectionDiscoveryResult {
  assignedCount: number;
  safeLabels: string[];
}

export class ConnectionDiscoveryUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConnectionDiscoveryUsageError';
  }
}

export function parseConnectionDiscoveryArguments(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== '--workspace') {
    throw new ConnectionDiscoveryUsageError(
      'Usage: pnpm sync:discover --workspace <workspace-uuid>',
    );
  }
  const workspaceId = arguments_[1] ?? '';
  if (!workspaceIdPattern.test(workspaceId)) {
    throw new ConnectionDiscoveryUsageError('The workspace must be a canonical UUID.');
  }
  return workspaceId;
}

function safeDisplayName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
}

export async function discoverConnections(
  options: DiscoverConnectionsOptions,
): Promise<ConnectionDiscoveryResult> {
  if (!workspaceIdPattern.test(options.workspaceId)) {
    throw new ConnectionDiscoveryUsageError('The workspace must be a canonical UUID.');
  }
  if (!(await options.repository.workspaceExists(options.workspaceId))) {
    throw new ConnectionDiscoveryUsageError('The assigned workspace does not exist.');
  }

  const connections = await options.provider.listConnections();
  const assigned = await options.repository.assignDiscoveredConnections(
    options.workspaceId,
    connections,
  );
  if (assigned.length !== connections.length) {
    throw new Error('Connection discovery assignment count mismatch.');
  }

  const safeLabels = connections.map((connection) => {
    const name = safeDisplayName(connection.displayName) || 'Unnamed institution';
    return `${name} — ${connection.localStatus}`;
  });
  options.writeLine(`Assigned ${safeLabels.length} connection(s).`);
  for (const [index, label] of safeLabels.entries()) {
    options.writeLine(`${index + 1}. ${label}`);
  }
  return { assignedCount: assigned.length, safeLabels };
}
