import { describe, expect, it } from "vitest";

import {
  lanceDeleteFilter,
  lancePathPrefixFilter,
  lanceStringLiteral,
} from "./lanceFilter";

describe("LanceDB filters", () => {
  it("quotes values and doubles an embedded quote", () => {
    expect(lanceStringLiteral("a'b")).toBe("'a''b'");
    expect(lanceDeleteFilter("key", "dir/it's.ts")).toBe(
      "cachekey = 'key' AND path = 'dir/it''s.ts'",
    );
    expect(lancePathPrefixFilter("src/it's")).toBe("path LIKE 'src/it''s%'");
  });

  it("does not end the string early when a path contains a quote", () => {
    const filter = lanceDeleteFilter("k", "a' OR path != 'a");
    expect(filter).toBe("cachekey = 'k' AND path = 'a'' OR path != ''a'");
    expect(filter.split("'").length % 2).toBe(1);
  });
});
