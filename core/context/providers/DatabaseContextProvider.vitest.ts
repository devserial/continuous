import { beforeEach, describe, expect, it, vi } from "vitest";

const created: { pool: { end: ReturnType<typeof vi.fn> } }[] = [];
const getDatabaseAdapter = vi.fn(
  (_type: string, connection: { database?: string }) => {
    if (connection.database === "down") {
      throw new Error("connection refused");
    }
    const adapter = {
      pool: { end: vi.fn(async () => {}) },
      getAllTablesAndSchemas: vi.fn(async () =>
        connection.database === "app"
          ? { "public.users": { id: "int" }, orders: { id: "int" } }
          : { widgets: { id: "int" } },
      ),
    };
    created.push(adapter);
    return adapter;
  },
);

vi.mock("dbinfoz", () => ({
  getDatabaseAdapter,
}));

import DatabaseContextProvider, {
  splitDatabaseQuery,
} from "./DatabaseContextProvider";

const extras = {} as any;

describe("splitDatabaseQuery", () => {
  it("splits on the first dot only", () => {
    expect(splitDatabaseQuery("app.public.users")).toEqual({
      connectionName: "app",
      table: "public.users",
    });
    expect(splitDatabaseQuery("app")).toEqual({
      connectionName: "app",
      table: undefined,
    });
  });
});

describe("DatabaseContextProvider", () => {
  beforeEach(() => {
    created.length = 0;
    getDatabaseAdapter.mockClear();
  });

  const connections = [
    {
      name: "app",
      connection_type: "postgres",
      connection: { database: "app" },
    },
    {
      name: "down",
      connection_type: "postgres",
      connection: { database: "down" },
    },
  ];

  it("treats a missing connection list as empty", async () => {
    const provider = new DatabaseContextProvider({});
    expect(await provider.getContextItems("app.orders", extras)).toEqual([]);
    expect(await provider.loadSubmenuItems({} as any)).toEqual([]);
    expect(getDatabaseAdapter).not.toHaveBeenCalled();
  });

  it("reuses one adapter and still lists the other connection when one fails", async () => {
    const provider = new DatabaseContextProvider({ connections });
    const first = await provider.loadSubmenuItems({} as any);
    const second = await provider.loadSubmenuItems({} as any);

    expect(first.map((item) => item.id)).toEqual([
      "app.all",
      "app.public.users",
      "app.orders",
    ]);
    expect(second).toEqual(first);
    const appOpens = getDatabaseAdapter.mock.calls.filter(
      (call) => call[1]?.database === "app",
    );
    expect(appOpens).toHaveLength(1);
  });

  it("finds a table whose name contains a dot", async () => {
    const provider = new DatabaseContextProvider({
      connections: [connections[0]],
    });
    const items = await provider.getContextItems("app.public.users", extras);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("app-public.users-schema");
    expect(items[0].content).toContain("public.users");
  });

  it("closes cached pools", async () => {
    const provider = new DatabaseContextProvider({
      connections: [connections[0]],
    });
    await provider.getContextItems("app.all", extras);
    expect(created).toHaveLength(1);
    await provider.close();
    expect(created[0].pool.end).toHaveBeenCalledTimes(1);

    await provider.getContextItems("app.all", extras);
    expect(created).toHaveLength(2);
  });
});
