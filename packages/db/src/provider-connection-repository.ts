import { eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ProviderConnectionDto } from '@cashcount/provider-core';

import { providerConnection, workspace } from './schema.js';
import type * as schema from './schema.js';

export interface AssignedProviderConnection {
  id: string;
  localStatus: string;
}

function instant(value: null | string): Date | null {
  return value === null ? null : new Date(value);
}

export class ProviderConnectionRepository {
  public constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  public async workspaceExists(workspaceId: string): Promise<boolean> {
    const rows = await this.database
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return rows.length === 1;
  }

  public async assignDiscoveredConnections(
    workspaceId: string,
    connections: readonly ProviderConnectionDto[],
  ): Promise<AssignedProviderConnection[]> {
    return this.database.transaction(async (transaction) => {
      const assigned: AssignedProviderConnection[] = [];
      for (const connection of connections) {
        const retainedLocalStatus: SQL<string> = sql`case
          when ${providerConnection.localStatus} = 'DISABLED' then 'DISABLED'
          else excluded.local_status
        end`;
        const rows = await transaction
          .insert(providerConnection)
          .values({
            actionRequiredAt: instant(connection.actionRequiredAt),
            consentExpiresAt: instant(connection.consentExpiresAt),
            deletedAt: connection.localStatus === 'DELETED' ? new Date() : null,
            displayName: connection.displayName,
            externalConnectionId: connection.externalConnectionId,
            externalConnectorId: connection.externalConnectorId,
            lastErrorCode: connection.errorCode,
            lastProviderUpdateAt: instant(connection.providerUpdatedAt),
            localStatus: connection.localStatus,
            provider: 'PLUGGY',
            providerExecutionStatus: connection.executionStatus,
            providerItemStatus: connection.itemStatus,
            workspaceId,
          })
          .onConflictDoUpdate({
            set: {
              actionRequiredAt: instant(connection.actionRequiredAt),
              consentExpiresAt: instant(connection.consentExpiresAt),
              deletedAt: connection.localStatus === 'DELETED' ? new Date() : null,
              displayName: connection.displayName,
              externalConnectorId: connection.externalConnectorId,
              lastErrorCode: connection.errorCode,
              lastProviderUpdateAt: instant(connection.providerUpdatedAt),
              localStatus: retainedLocalStatus,
              providerExecutionStatus: connection.executionStatus,
              providerItemStatus: connection.itemStatus,
              updatedAt: new Date(),
            },
            target: [
              providerConnection.workspaceId,
              providerConnection.provider,
              providerConnection.externalConnectionId,
            ],
          })
          .returning({ id: providerConnection.id, localStatus: providerConnection.localStatus });
        const row = rows[0];
        if (row === undefined) throw new Error('Provider connection assignment returned no row.');
        assigned.push(row);
      }
      return assigned;
    });
  }
}
