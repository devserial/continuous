import { describe, expect, it } from "vitest";

import {
  forgetPendingNewFile,
  pendingEditorForFilepath,
  pendingFilepathForEditor,
  trackPendingNewFile,
} from "./pendingNewFile";

describe("pending new files", () => {
  it("remembers an untitled editor until the apply is finished", () => {
    trackPendingNewFile("untitled:Untitled-1", "file:///ws/new.ts");
    expect(pendingEditorForFilepath("file:///ws/new.ts")).toBe(
      "untitled:Untitled-1",
    );
    expect(pendingFilepathForEditor("untitled:Untitled-1")).toBe(
      "file:///ws/new.ts",
    );

    forgetPendingNewFile("file:///ws/new.ts");
    expect(pendingEditorForFilepath("file:///ws/new.ts")).toBeUndefined();
    expect(pendingFilepathForEditor("untitled:Untitled-1")).toBeUndefined();
  });
});
