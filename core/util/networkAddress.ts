import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Whether an IP address is not on the public internet: loopback, private
 * ranges, link-local (which includes the cloud metadata address
 * 169.254.169.254), carrier-grade NAT, unspecified, and the IPv6 equivalents,
 * including addresses that embed an IPv4 address (IPv4-mapped, NAT64, 6to4,
 * IPv4-compatible).
 */
export function isNonPublicAddress(address: string): boolean {
  const ip = normalizeHost(address);
  const kind = isIP(ip);
  if (kind === 4) return isNonPublicIPv4(ip);
  if (kind === 6) {
    const parsed = parseIPv6(ip);
    // An address Node accepts but we cannot parse is treated as non-public.
    if (parsed === null) return true;
    return isNonPublicIPv6(parsed);
  }
  return false;
}

function isNonPublicIPv4(ip: string): boolean {
  return isNonPublicIPv4Num(ipv4ToNum(ip));
}

function isNonPublicIPv4Num(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

function ipv4ToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

/** Expand an IPv6 address, including a dotted or hex IPv4 tail, to 128 bits. */
function parseIPv6(ip: string): bigint | null {
  let text = ip;
  const lastColon = text.lastIndexOf(":");
  const tail = lastColon === -1 ? text : text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const v4 = ipv4ToNum(tail);
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = text.slice(0, lastColon + 1) + hi + ":" + lo;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): string[] | null => {
    if (side === "") return [];
    const groups = side.split(":");
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups;
  };
  const head = parseSide(halves[0]);
  if (!head) return null;
  const tailGroups = halves.length === 2 ? parseSide(halves[1]) : [];
  if (!tailGroups) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tailGroups.length > 7) return null;
  const zeros = halves.length === 2 ? 8 - head.length - tailGroups.length : 0;
  const groups = [...head, ...Array(zeros).fill("0"), ...tailGroups];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

function isNonPublicIPv6(value: bigint): boolean {
  if (value === 0n || value === 1n) return true; // :: and ::1
  const high96 = value >> 32n;
  const v4 = Number(value & 0xffffffffn);
  // IPv4-mapped (::ffff:0:0/96), including the hex form URL parsers produce.
  if (high96 === 0xffffn) return isNonPublicIPv4Num(v4);
  // IPv4-compatible (::/96).
  if (high96 === 0n) return isNonPublicIPv4Num(v4);
  // Well-known NAT64 prefix 64:ff9b::/96. Judged by the embedded IPv4 address.
  if (high96 === 0x64ff9bn << 64n) return isNonPublicIPv4Num(v4);
  // Local-use NAT64 prefix 64:ff9b:1::/48. Always a local translator.
  if (value >> 80n === 0x64ff9b0001n) return true;
  // 6to4 (2002::/16) carries an IPv4 address in the next 32 bits.
  if (value >> 112n === 0x2002n) {
    return isNonPublicIPv4Num(Number((value >> 80n) & 0xffffffffn));
  }
  const top = Number(value >> 112n);
  if ((top & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((top & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((top & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((top & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Names that never point at a public host. */
const NON_PUBLIC_NAME = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

/** Compare hosts without brackets, a zone id, or a trailing dot. */
export function normalizeHost(hostname: string): string {
  const stripped = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const zone = stripped.indexOf("%");
  return zone === -1 ? stripped : stripped.slice(0, zone);
}

/** Judged from the hostname alone (no DNS): literal addresses and local names. */
export function isNonPublicHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (isIP(host)) return isNonPublicAddress(host);
  return NON_PUBLIC_NAME.test(host);
}

export type Resolver = (hostname: string) => Promise<string[]>;

const resolveAll: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((record) => record.address);

/** How long a checked resolution is reused, so the later connection cannot see a different address. */
const PIN_MS = 10 * 60 * 1000;

let hostResolver: Resolver = resolveAll;
const pinCache = new Map<string, { addresses: string[]; at: number }>();

/** Replace name resolution. Used by tests; pass undefined to restore DNS. */
export function setHostResolver(resolver?: Resolver): void {
  hostResolver = resolver ?? resolveAll;
  pinCache.clear();
}

export function clearPinnedHosts(): void {
  pinCache.clear();
}

/**
 * Addresses for a host. A repeated call within the pin window returns the
 * addresses already checked, not a fresh lookup.
 */
export async function resolveHostAddresses(
  hostname: string,
): Promise<string[]> {
  const host = normalizeHost(hostname);
  if (!host) return [];
  if (isIP(host)) return [host];
  const cached = pinCache.get(host);
  if (cached && Date.now() - cached.at < PIN_MS) return cached.addresses;
  try {
    const addresses = (await hostResolver(host)).map(normalizeHost);
    pinCache.set(host, { addresses, at: Date.now() });
    return addresses;
  } catch {
    return [];
  }
}

/** Addresses already checked for this host, if the pin window is still open. */
export function peekHostAddresses(hostname: string): string[] | undefined {
  const host = normalizeHost(hostname);
  if (isIP(host)) return [host];
  const cached = pinCache.get(host);
  if (!cached || Date.now() - cached.at >= PIN_MS) return undefined;
  return cached.addresses;
}

export async function classifyHost(
  hostname: string,
): Promise<{ addresses: string[]; nonPublic: boolean }> {
  const host = normalizeHost(hostname);
  const literal = isNonPublicHostname(host);
  const addresses = await resolveHostAddresses(host);
  return {
    addresses,
    nonPublic: literal || addresses.some(isNonPublicAddress),
  };
}

/**
 * A fetch target that must ask: a literal private address, a local name, a
 * name already resolved to a private address, or a preprocess result that says so.
 */
export function isPrivateFetchTarget(
  rawUrl: unknown,
  processed?: Record<string, unknown>,
): boolean {
  if (processed?.nonPublic === true) return true;
  if (typeof rawUrl !== "string" || !rawUrl) return false;
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  if (isNonPublicHostname(host)) return true;
  return !!peekHostAddresses(host)?.some(isNonPublicAddress);
}

export type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A `lookup` that returns only the addresses already checked, so the
 * connection cannot follow a different answer from DNS.
 */
export function pinnedLookup(addresses: string[]) {
  const records = addresses.map((address) => {
    const ip = normalizeHost(address);
    return { address: ip, family: isIP(ip) === 6 ? 6 : 4 };
  });
  return (
    hostname: string,
    options: unknown,
    callback?: LookupCallback,
  ): void => {
    const cb: LookupCallback | undefined =
      typeof options === "function" ? (options as LookupCallback) : callback;
    if (!records.length) {
      const error = new Error(
        `No pinned address for ${hostname}`,
      ) as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      cb?.(error, "", 0);
      return;
    }
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      Boolean((options as { all?: boolean }).all);
    if (all) cb?.(null, records);
    else cb?.(null, records[0].address, records[0].family);
  };
}

/**
 * Whether a hostname is, or resolves to, a non-public address. A name that
 * cannot be resolved is not treated as non-public (the fetch will fail).
 * A resolver passed in is used once and not pinned; the default resolver is.
 */
export async function resolvesToNonPublic(
  hostname: string,
  resolve?: Resolver,
): Promise<boolean> {
  if (!resolve) return (await classifyHost(hostname)).nonPublic;
  if (isNonPublicHostname(hostname)) return true;
  try {
    return (await resolve(normalizeHost(hostname))).some(isNonPublicAddress);
  } catch {
    return false;
  }
}
