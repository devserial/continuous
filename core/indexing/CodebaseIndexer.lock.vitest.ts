import { beforeEach, describe, expect, it, vi } from "vitest";

const { lock, unlock } = vi.hoisted(() => ({
  lock: vi.fn(async () => {}),
  unlock: vi.fn(async () => {}),
}));

vi.mock("../llm/index.js", () => ({
  LLMError: class LLMError extends Error {},
}));
vi.mock("../continueServer/stubs/client.js", () => ({
  ContinueServerClient: class {},
}));
vi.mock("../config/ConfigHandler.js", () => ({
  ConfigHandler: class {},
}));
vi.mock("../util/Logger.js", () => ({
  Logger: { error() {}, debug() {} },
}));
vi.mock("../util/paths.js", () => ({
  getIndexSqlitePath: () => "/tmp/index.sqlite",
  getLanceDbPath: () => "/tmp/lancedb",
}));
vi.mock("./LanceDbIndex.js", () => ({ LanceDbIndex: class {} }));
vi.mock("./chunk/ChunkCodebaseIndex.js", () => ({
  ChunkCodebaseIndex: class {},
}));
vi.mock("./CodeSnippetsIndex.js", () => ({
  CodeSnippetsCodebaseIndex: class {},
}));
vi.mock("./FullTextSearchCodebaseIndex.js", () => ({
  FullTextSearchCodebaseIndex: class {
    static artifactId = "fts";
  },
}));
vi.mock("./docs/DocsService.js", () => ({
  embedModelsAreEqual: () => true,
}));
vi.mock("./walkDir.js", () => ({
  walkDirAsync: async function* () {},
}));
vi.mock("./refreshIndex.js", () => ({
  IndexLock: {
    isLocked: vi.fn(async () => undefined),
    lock,
    unlock,
    updateTimestamp: vi.fn(async () => {}),
  },
  getComputeDeleteAddRemove: vi.fn(),
}));

import { CodebaseIndexer } from "./CodebaseIndexer.js";

class FlakyIndexer extends CodebaseIndexer {
  async *refreshDirs(): AsyncGenerator<never> {
    throw new Error("index failed");
  }

  override async handleIndexingError(): Promise<void> {
    throw new Error("report failed");
  }
}

describe("refreshCodebaseIndex lock", () => {
  beforeEach(() => {
    lock.mockClear();
    unlock.mockClear();
  });

  it("unlocks when reporting the indexing error also throws", async () => {
    const indexer = new FlakyIndexer(
      {
        loadConfig: async () => ({ config: undefined }),
        onConfigUpdate: () => {},
      } as any,
      {} as any,
    );
    await indexer.initPromise;

    await indexer.refreshCodebaseIndex(["/tmp/workspace"]);

    expect(lock).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledTimes(1);
  });
});
