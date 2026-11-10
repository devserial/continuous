import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContinueConfig, IDE } from "../../..";
import DocsCrawler from "./DocsCrawler";

const ide = { showToast: async () => undefined } as unknown as IDE;
const config = { experimental: {} } as ContinueConfig;

async function crawl(useLocalCrawling?: boolean) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("proxy-server-blue-l6vsfbzhba-uw.a.run.app")) {
      return new Response(
        JSON.stringify([
          { url: "https://example.com/docs", path: "/docs", content: "remote" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("<html><body><p>local</p></body></html>", {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const crawler = new DocsCrawler(
      ide,
      config,
      0,
      1,
      useLocalCrawling !== false,
    );
    const pages = [];
    const generator = crawler.crawl(new URL("https://example.com/docs"));
    let kind = "";
    for (;;) {
      const step = await generator.next();
      if (step.done) {
        kind = step.value;
        break;
      }
      pages.push(step.value);
    }
    return { calls, pages, kind };
  } finally {
    globalThis.fetch = original;
  }
}

describe("docs crawl reporting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("crawls on this machine unless the upstream service is opted into", async () => {
    const local = await crawl(undefined);
    expect(local.calls.some((url) => url.includes("a.run.app"))).toBe(false);

    const remote = await crawl(false);
    expect(remote.calls.some((url) => url.includes("/crawl"))).toBe(true);
    expect(remote.kind).toBe("default");
    expect(remote.pages[0]?.content).toBe("remote");
  });
});
