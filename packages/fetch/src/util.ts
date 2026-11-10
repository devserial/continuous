import { RequestOptions } from "@continuedev/config-types";
import { BlockList, isIP } from "node:net";

/**
 * Gets the proxy settings from environment variables
 * @param protocol The URL protocol (http: or https:)
 * @returns The proxy URL if available, otherwise undefined
 */
export function getProxyFromEnv(protocol: string): string | undefined {
  if (protocol === "https:") {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy
    );
  } else {
    return process.env.HTTP_PROXY || process.env.http_proxy;
  }
}

// Note that request options proxy (per model) takes precedence over environment variables
export function getProxy(
  protocol: string,
  requestOptions?: RequestOptions,
): string | undefined {
  if (requestOptions?.proxy) {
    return requestOptions.proxy;
  }
  return getProxyFromEnv(protocol);
}

export function getEnvNoProxyPatterns(): string[] {
  const envValue = process.env.NO_PROXY || process.env.no_proxy;
  if (envValue && typeof envValue === "string") {
    return envValue
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((i) => !!i);
  } else {
    return [];
  }
}

export function getReqOptionsNoProxyPatterns(
  options: RequestOptions | undefined,
): string[] {
  return (
    options?.noProxy?.map((i) => i.trim().toLowerCase()).filter((i) => !!i) ??
    []
  );
}

/** Split `host:port` without treating an IPv6 address or a CIDR prefix as a port. */
function splitHostPort(value: string): [string, string | undefined] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end !== -1) {
      const host = value.slice(1, end);
      const rest = value.slice(end + 1);
      return [host, rest.startsWith(":") ? rest.slice(1) : undefined];
    }
  }
  if (value.includes("/")) return [value, undefined];
  const colon = value.lastIndexOf(":");
  if (colon === -1 || value.indexOf(":") !== colon) return [value, undefined];
  return [value.slice(0, colon), value.slice(colon + 1)];
}

function cidrMatches(hostname: string, pattern: string): boolean {
  const slash = pattern.lastIndexOf("/");
  if (slash <= 0) return false;
  const network = pattern.slice(0, slash);
  const bits = Number(pattern.slice(slash + 1));
  const family = isIP(network);
  if (!family || !Number.isInteger(bits) || isIP(hostname) !== family) {
    return false;
  }
  const block = new BlockList();
  try {
    block.addSubnet(network, bits, family === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
  return block.check(hostname, family === 4 ? "ipv4" : "ipv6");
}

export function patternMatchesHostname(hostname: string, pattern: string) {
  const [hostnameWithoutPort, hostnamePort] = splitHostPort(
    hostname.toLowerCase(),
  );
  const [patternWithoutPort, patternPort] = splitHostPort(
    pattern.toLowerCase(),
  );

  // If pattern specifies a port but hostname doesn't match it, no match
  if (patternPort && (!hostnamePort || hostnamePort !== patternPort)) {
    return false;
  }

  if (patternWithoutPort === "*") return true;

  if (cidrMatches(hostnameWithoutPort, patternWithoutPort)) return true;

  // *.example.com matches a subdomain, not the apex.
  if (patternWithoutPort.startsWith("*.")) {
    const suffix = patternWithoutPort.slice(1);
    return (
      hostnameWithoutPort.length > suffix.length &&
      hostnameWithoutPort.endsWith(suffix)
    );
  }

  // A bare domain and a leading-dot domain are the same suffix match, and the
  // boundary is a dot: `.corp.example.com` does not match `evilcorp.example.com`.
  const domain = patternWithoutPort.replace(/^\.+/, "");
  if (!domain || domain.includes("*")) return false;
  return (
    hostnameWithoutPort === domain || hostnameWithoutPort.endsWith("." + domain)
  );
}

/**
 * Checks if a hostname should bypass proxy based on NO_PROXY environment variable
 * @param hostname The hostname to check
 * @returns True if the hostname should bypass proxy
 */
export function shouldBypassProxy(
  hostname: string,
  requestOptions: RequestOptions | undefined,
): boolean {
  const ignores = [
    ...getEnvNoProxyPatterns(),
    ...getReqOptionsNoProxyPatterns(requestOptions),
  ];
  const hostLowerCase = hostname.toLowerCase();
  return ignores.some((ignore) =>
    patternMatchesHostname(hostLowerCase, ignore),
  );
}
