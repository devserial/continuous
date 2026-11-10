const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOCAL_SCHEMES = new Set([
  "data:",
  "blob:",
  "file:",
  "vscode-webview:",
  "vscode-file:",
]);

export interface ImageSourceRisk {
  /** Host a remote image would contact, when there is one. */
  remoteHost?: string;
  queryParams: Record<string, string>;
  hasQueryParams: boolean;
}

/**
 * A remote image sends its whole URL, path included, to that host.
 * Local, data and webview images do not.
 */
export function imageSourceRisk(
  src: string,
  baseHref = "https://localhost/",
): ImageSourceRisk {
  const queryParams: Record<string, string> = {};
  let remoteHost: string | undefined;
  try {
    const url = new URL(src, baseHref);
    url.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });
    const scheme = url.protocol.toLowerCase();
    const host = url.hostname.toLowerCase();
    if (!LOCAL_SCHEMES.has(scheme) && !LOCAL_HOSTS.has(host) && host) {
      remoteHost = url.host;
    }
  } catch {
    const queryIndex = src.indexOf("?");
    if (queryIndex > -1) {
      const params = new URLSearchParams(src.substring(queryIndex));
      params.forEach((value, key) => {
        queryParams[key] = value;
      });
    }
    remoteHost = src;
  }
  return {
    remoteHost,
    queryParams,
    hasQueryParams: Object.keys(queryParams).length > 0,
  };
}
