import { describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({
  Pool: class {
    constructor(public config: unknown) {}
    async query() {
      return { rows: [] };
    }
    async end() {
      const g = globalThis as { __pgPoolEnds?: number };
      g.__pgPoolEnds = (g.__pgPoolEnds ?? 0) + 1;
    }
  },
}));

import PostgresContextProvider, {
  columnsQuery,
  postgresPoolConfig,
  quotePgIdent,
  sampleRowLimit,
  sampleRowsQuery,
  splitSchemaTable,
  tablesInSchemaQuery,
} from "./PostgresContextProvider";

describe("Postgres context provider SQL", () => {
  it("passes schema and table names as parameters", () => {
    expect(tablesInSchemaQuery("public")).toEqual({
      text: expect.stringContaining("WHERE table_schema = $1"),
      values: ["public"],
    });
    expect(tablesInSchemaQuery("pub'lic")).toEqual({
      text: expect.stringContaining("WHERE table_schema = $1"),
      values: ["pub'lic"],
    });
    expect(columnsQuery("public", "users").values).toEqual(["public", "users"]);
  });

  it("quotes identifiers so a table name cannot start another statement", () => {
    const { schema, table } = splitSchemaTable('public.t"; DROP TABLE x');
    const sql = sampleRowsQuery(schema, table, 3);
    // The semicolon stays inside the quoted identifier. It is not a second statement.
    expect(sql).toBe('SELECT * FROM "public"."t""; DROP TABLE x" LIMIT 3');
    expect(sql.startsWith("SELECT * FROM ")).toBe(true);
    expect(sql.endsWith('" LIMIT 3')).toBe(true);
  });

  it("rejects a limit that is not a small integer", () => {
    expect(sampleRowLimit("3; DROP TABLE x", 3)).toBe(3);
    expect(sampleRowLimit(5, 3)).toBe(5);
    expect(quotePgIdent('a"b')).toBe('"a""b"');
  });

  it("closes the pool after reading a table", async () => {
    (globalThis as { __pgPoolEnds?: number }).__pgPoolEnds = 0;
    const provider = new PostgresContextProvider({
      host: "localhost",
      database: "app",
      ssl: true,
    });
    await provider.getContextItems("public.users");
    expect((globalThis as { __pgPoolEnds?: number }).__pgPoolEnds).toBe(1);
  });

  it("passes ssl through and omits it when unset", () => {
    expect(
      postgresPoolConfig({ host: "db", ssl: { rejectUnauthorized: true } }).ssl,
    ).toEqual({
      rejectUnauthorized: true,
    });
    expect(postgresPoolConfig({ host: "localhost" }).ssl).toBeUndefined();
  });
});
