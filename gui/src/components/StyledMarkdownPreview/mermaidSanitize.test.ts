import { describe, expect, it } from "vitest";
import { MERMAID_SECURITY_LEVEL, sanitizeMermaidSvg } from "./mermaidSanitize";

describe("sanitizeMermaidSvg", () => {
  it("uses Mermaid's strict security level", () => {
    expect(MERMAID_SECURITY_LEVEL).toBe("strict");
  });

  it("drops script and javascript links and keeps the drawing", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a xlink:href="javascript:alert(1)"><text>Open</text></a>
      <script>alert(1)</script>
      <rect width="10" height="10"></rect>
    </svg>`;
    const clean = sanitizeMermaidSvg(svg);
    expect(clean.toLowerCase()).not.toContain("<script");
    expect(clean.toLowerCase()).not.toContain("javascript:");
    expect(clean).toContain("<rect");
    expect(clean).toContain("Open");
  });

  it("keeps an https link", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a xlink:href="https://example.com/docs"><text>Docs</text></a>
    </svg>`;
    expect(sanitizeMermaidSvg(svg)).toContain("https://example.com/docs");
  });

  it("drops command and file links", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a xlink:href="command:workbench.action.reloadWindow"><text>A</text></a>
      <a href="file:///tmp/run"><text>B</text></a>
    </svg>`;
    const clean = sanitizeMermaidSvg(svg);
    expect(clean.toLowerCase()).not.toContain("command:");
    expect(clean.toLowerCase()).not.toContain("file:");
  });
});
