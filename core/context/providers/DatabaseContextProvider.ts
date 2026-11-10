import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
  ContextSubmenuItem,
  LoadSubmenuItemsArgs,
} from "../../index.js";
import { BaseContextProvider } from "../index.js";

// dbinfoz loads the native sqlite3 binary when imported, so import it only
// when a database connection is used (see util/sqlite.ts)
async function getDatabaseAdapter(connectionType: string, connection: any) {
  const { getDatabaseAdapter } = await import("dbinfoz");
  // @ts-ignore (incorrect typings on module's declaration file)
  return getDatabaseAdapter(connectionType, connection);
}

function connectionKey(connection: any): string {
  let settings = "";
  try {
    settings = JSON.stringify(connection?.connection ?? {});
  } catch {
    settings = "";
  }
  return `${connection?.name ?? ""}:${connection?.connection_type ?? ""}:${settings}`;
}

/** Split `connection.table` on the first dot so a table name may contain dots. */
export function splitDatabaseQuery(query: string): {
  connectionName: string;
  table: string | undefined;
} {
  const dot = query.indexOf(".");
  if (dot === -1) {
    return { connectionName: query, table: undefined };
  }
  return {
    connectionName: query.slice(0, dot),
    table: query.slice(dot + 1),
  };
}

async function closeDatabaseAdapter(adapter: any): Promise<void> {
  try {
    if (typeof adapter?.close === "function") {
      await adapter.close();
      return;
    }
    if (typeof adapter?.pool?.end === "function") {
      await adapter.pool.end();
      return;
    }
    if (typeof adapter?.pool?.close === "function") {
      await adapter.pool.close();
    }
  } catch (e) {
    console.error("Failed to close database adapter", e);
  }
}

class DatabaseContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "database",
    displayTitle: "Database",
    description: "Table schemas",
    type: "submenu",
    renderInlineAs: "",
  };

  private adapters = new Map<string, any>();

  get deprecationMessage() {
    return "The database context provider is deprecated and may be removed in a later version. Please consider using a database MCP server like postgres-mcp (https://github.com/crystaldba/postgres-mcp) instead.";
  }

  private connectionList(): any[] {
    const connections = this.options?.connections;
    return Array.isArray(connections) ? connections : [];
  }

  private async adapterFor(connection: any): Promise<any> {
    const key = connectionKey(connection);
    const cached = this.adapters.get(key);
    if (cached) return cached;
    const adapter = await getDatabaseAdapter(
      connection.connection_type,
      connection.connection,
    );
    this.adapters.set(key, adapter);
    return adapter;
  }

  private async dropStaleAdapters(): Promise<void> {
    const live = new Set(this.connectionList().map(connectionKey));
    for (const [key, adapter] of this.adapters) {
      if (live.has(key)) continue;
      this.adapters.delete(key);
      await closeDatabaseAdapter(adapter);
    }
  }

  /** Close every pool. Called when the config that owns this provider is dropped. */
  async close(): Promise<void> {
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    for (const adapter of adapters) {
      await closeDatabaseAdapter(adapter);
    }
  }

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    const contextItems: ContextItem[] = [];
    const connections = this.connectionList();
    if (connections.length === 0) {
      return contextItems;
    }

    await this.dropStaleAdapters();
    const { connectionName, table } = splitDatabaseQuery(query);

    for (const connection of connections) {
      if (connection.name !== connectionName) continue;
      try {
        const adapter = await this.adapterFor(connection);
        const tablesAndSchemas = await adapter.getAllTablesAndSchemas(
          connection.connection.database,
        );

        if (table === "all") {
          let prompt = `Schema for all tables on ${connection.connection_type} is `;
          prompt += JSON.stringify(tablesAndSchemas);

          contextItems.push({
            name: `${connectionName}-all-tables-schemas`,
            description: "Schema for all tables.",
            content: prompt,
          });
        } else {
          for (const tableName of Object.keys(tablesAndSchemas)) {
            if (table !== tableName) continue;
            let prompt = `Schema for ${tableName} on ${connection.connection_type} is `;
            prompt += JSON.stringify(tablesAndSchemas[tableName]);

            contextItems.push({
              name: `${connectionName}-${tableName}-schema`,
              description: `${tableName} Schema`,
              content: prompt,
            });
          }
        }
      } catch (e) {
        console.error(
          `Failed to read database connection ${connection?.name}:`,
          e,
        );
      }
    }

    return contextItems;
  }

  async loadSubmenuItems(
    args: LoadSubmenuItemsArgs,
  ): Promise<ContextSubmenuItem[]> {
    const contextItems: ContextSubmenuItem[] = [];
    const connections = this.connectionList();
    if (connections.length === 0) {
      return contextItems;
    }

    await this.dropStaleAdapters();

    for (const connection of connections) {
      try {
        const adapter = await this.adapterFor(connection);
        const tablesAndSchemas = await adapter.getAllTablesAndSchemas(
          connection.connection.database,
        );
        const tables = Object.keys(tablesAndSchemas);

        contextItems.push({
          id: `${connection.name}.all`,
          title: `${connection.name} all table schemas`,
          description: "",
        });

        for (const tableName of tables) {
          contextItems.push({
            id: `${connection.name}.${tableName}`,
            title: `${connection.name}.${tableName} schema`,
            description: "",
          });
        }
      } catch (e) {
        console.error(
          `Failed to list database connection ${connection?.name}:`,
          e,
        );
      }
    }

    return contextItems;
  }
}

export default DatabaseContextProvider;
