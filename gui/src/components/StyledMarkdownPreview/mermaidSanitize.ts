import DOMPurify from "dompurify";

/**
 * Mermaid's strict mode sanitizes diagram links and the SVG it returns.
 * The panel sanitizes again before inserting the markup.
 */
export const MERMAID_SECURITY_LEVEL = "strict" as const;

const SAFE_SVG_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

function isSafeSvgUrl(value: string): boolean {
  const trimmed = value.trim();
  if (
    !trimmed ||
    /^\s*javascript:/i.test(trimmed) ||
    /^\s*data:/i.test(trimmed)
  ) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return SAFE_SVG_URL.test(trimmed);
  }
  return !trimmed.startsWith("//");
}

/** Removes script and non-http(s) links from a diagram SVG. */
export function sanitizeMermaidSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["foreignObject"],
    FORBID_TAGS: ["script", "iframe", "object", "embed"],
    FORBID_ATTR: ["onload", "onclick", "onmouseover", "onfocus", "onerror"],
  });
  if (!clean || typeof DOMParser === "undefined") {
    return clean;
  }
  const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() === "parsererror") {
    return "";
  }
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of ["href", "xlink:href"]) {
      const value = el.getAttribute(attr);
      if (value !== null && !isSafeSvgUrl(value)) {
        el.removeAttribute(attr);
      }
    }
  });
  return root.outerHTML;
}
