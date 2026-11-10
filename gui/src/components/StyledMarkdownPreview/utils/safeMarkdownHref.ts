const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Chat markdown may link to http(s) and mailto. Other schemes, including
 * command links, are dropped so a click cannot leave the page.
 */
export function safeMarkdownHref(
  href: string | undefined | null,
): string | undefined {
  if (typeof href !== "string") return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("//")) return undefined;
  if (trimmed.startsWith("#")) return trimmed;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!scheme) return trimmed;
  try {
    const url = new URL(trimmed);
    return ALLOWED_SCHEMES.has(url.protocol) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
