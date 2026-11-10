/** True for an https URL with a host. Used before the panel opens a link. */
export function isHttpsLink(url: string | undefined | null): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
