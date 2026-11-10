import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
  ContextSubmenuItem,
  LoadSubmenuItemsArgs,
} from "../../index.js";
import { BaseContextProvider } from "../index.js";

/** Double quotes inside an identifier, then wrap it. A name cannot change the statement. */
export function quotePgIdent(ident: string): string {
  if (ident.length === 0 || ident.includes("\0")) {
    throw new Error("Invalid SQL identifier");
  }
  return `"${ident.replace(/"/g, '""')}"`;
}

/** `schema.table`, split on the first dot. Both parts are still quoted later. */
export function splitSchemaTable(qualified: string): {
  schema: string;
  table: string;
} {
  const dot = qualified.indexOf(".");
  if (dot <= 0 || dot === qualified.length - 1) {
    throw new Error(
      `Table name must be in format schema.table_name, got ${qualified}`,
    );
  }
  return {
    schema: qualified.slice(0, dot),
    table: qualified.slice(dot + 1),
  };
}

/** A positive integer limit, or the fallback. Never interpolated from raw text. */
export function sampleRowLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    return fallback;
  }
  return n;
}

/**
 * node-postgres pool options. `ssl` is passed through when set, so a remote
 * database can require TLS. It is omitted when unset, which keeps a local
 * server that does not speak TLS working.
 */
export function postgresPoolConfig(options: {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: unknown;
}): Record<string, unknown> {
  return {
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  };
}

export function tablesInSchemaQuery(schema: string | null): {
  text: string;
  values: string[];
} {
  const text = `
SELECT table_schema, table_name
FROM information_schema.tables`;
  if (schema === null) {
    return { text, values: [] };
  }
  return { text: `${text} WHERE table_schema = $1`, values: [schema] };
}

export function columnsQuery(
  schema: string,
  table: string,
): { text: string; values: string[] } {
  return {
    text: `
SELECT column_name, data_type, character_maximum_length
FROM INFORMATION_SCHEMA.COLUMNS
WHERE table_schema = $1
  AND table_name = $2`,
    values: [schema, table],
  };
}

export function sampleRowsQuery(
  schema: string,
  table: string,
  limit: number,
): string {
  return `SELECT * FROM ${quotePgIdent(schema)}.${quotePgIdent(table)} LIMIT ${limit}`;
}

class PostgresContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "postgres",
    displayTitle: "PostgreSQL",
    description: "Retrieve PostgreSQL table schema and sample rows",
    type: "submenu",
    renderInlineAs: "",
  };

  static ALL_TABLES = "__all_tables";
  static DEFAULT_SAMPLE_ROWS = 3;

  private async getPool() {
    // @ts-ignore
    const pg = await import("pg");

    return new pg.Pool(postgresPoolConfig(this.options));
  }

  private async closePool(pool: { end: () => Promise<unknown> }) {
    try {
      await pool.end();
    } catch {
      // Closing is cleanup. A failure here should not hide the query error.
    }
  }

  private async getTableNames(pool: any): Promise<string[]> {
    const schema = this.options.schema ?? "public";
    const tablesInfoQuery = tablesInSchemaQuery(schema);
    const { rows: tablesInfo } = await pool.query(
      tablesInfoQuery.text,
      tablesInfoQuery.values,
    );
    return tablesInfo.map(
      (tableInfo: any) => `${tableInfo.table_schema}.${tableInfo.table_name}`,
    );
  }

  async getContextItems(
    query = "",
    _: ContextProviderExtras = {} as ContextProviderExtras,
  ): Promise<ContextItem[]> {
    const pool = await this.getPool();

    try {
      const contextItems: ContextItem[] = [];

      const tableNames = [];
      if (query === PostgresContextProvider.ALL_TABLES) {
        tableNames.push(...(await this.getTableNames(pool)));
      } else {
        tableNames.push(query);
      }

      for (const tableName of tableNames) {
        const { schema, table } = splitSchemaTable(tableName);
        const schemaQuery = columnsQuery(schema, table);
        const { rows: tableSchema } = await pool.query(
          schemaQuery.text,
          schemaQuery.values,
        );

        // Get the sample rows
        const sampleRows = sampleRowLimit(
          this.options.sampleRows,
          PostgresContextProvider.DEFAULT_SAMPLE_ROWS,
        );
        const { rows: sampleRowResults } = await pool.query(
          sampleRowsQuery(schema, table, sampleRows),
        );

        // Create prompt from the table schema and sample rows
        let prompt = `Postgres schema for database ${this.options.database} table ${tableName}:\n`;
        prompt += `${JSON.stringify(tableSchema, null, 2)}\n\n`;
        prompt += `Sample rows: ${JSON.stringify(sampleRowResults, null, 2)}`;

        contextItems.push({
          name: `${this.options.database}-${tableName}-schema-and-sample-rows`,
          description: `Schema and sample rows for table ${tableName}`,
          content: prompt,
        });
      }

      return contextItems;
    } catch (error) {
      throw new Error(`Failed to query PostgreSQL database: ${error}`);
    } finally {
      await this.closePool(pool);
    }
  }

  async loadSubmenuItems(
    _: LoadSubmenuItemsArgs,
  ): Promise<ContextSubmenuItem[]> {
    const pool = await this.getPool();

    try {
      const contextItems: ContextSubmenuItem[] = [];
      const tableNames = await this.getTableNames(pool);

      for (const tableName of tableNames) {
        contextItems.push({
          id: tableName,
          title: tableName,
          description: `Schema from ${tableName} and ${this.options.sampleRows} sample rows.`,
        });
      }
      contextItems.push({
        id: PostgresContextProvider.ALL_TABLES,
        title: "All tables",
        description: `Schema from all tables and ${this.options.sampleRows} sample rows each.`,
      });

      return contextItems;
    } catch (error) {
      throw new Error(`Failed to query PostgreSQL database: ${error}`);
    } finally {
      await this.closePool(pool);
    }
  }

  get deprecationMessage() {
    return "The Postgres context provider is deprecated. Please consider using the Postgres MCP (such as github.com/crystaldba/postgres-mcp) instead.";
  }
}

export default PostgresContextProvider;
