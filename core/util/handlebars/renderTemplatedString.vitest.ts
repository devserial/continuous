import Handlebars from "handlebars";
import { describe, expect, it } from "vitest";
import { resolveHelperPromises } from "./handlebarUtils";
import { renderTemplatedString } from "./renderTemplatedString";

describe("legacy systemMessage templating", () => {
  it("inserts file text without HTML escaping, including a repeated reference", async () => {
    const file = `const q = "hi" & 'there';`;
    const rendered = await renderTemplatedString(
      Handlebars,
      "first {{src/a.js}} second {{src/a.js}}",
      {},
      [],
      async () => file,
      async () => "file:///src/a.js",
    );

    expect(rendered).toBe(`first ${file} second ${file}`);
    expect(rendered).not.toContain("&quot;");
    expect(rendered).not.toContain("&amp;");
  });

  it("does not treat dollar sequences in helper output as replacement patterns", async () => {
    const rendered = await resolveHelperPromises("before __id__ after", {
      id: Promise.resolve("cost is $& plus $'"),
    });
    expect(rendered).toBe("before cost is $& plus $' after");
  });
});
