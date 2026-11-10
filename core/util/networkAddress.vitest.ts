import { describe, expect, it } from "vitest";
import {
  classifyHost,
  clearPinnedHosts,
  isNonPublicAddress,
  isNonPublicHostname,
  pinnedLookup,
  resolvesToNonPublic,
  setHostResolver,
} from "./networkAddress";

describe("isNonPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "[::1]",
    // WHATWG URL normalises [::ffff:169.254.169.254] to this hex form.
    "::ffff:a9fe:a9fe",
    "[::ffff:a9fe:a9fe]",
    "::ffff:7f00:1",
    // NAT64 (64:ff9b::/96) and 6to4 with an embedded private address.
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "2002:a9fe:a9fe::",
    // Deprecated IPv4-compatible form.
    "::a9fe:a9fe",
    "::7f00:1",
    // Local-use NAT64 prefix.
    "64:ff9b:1::",
  ])("%s is non-public", (ip) => expect(isNonPublicAddress(ip)).toBe(true));

  it.each([
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "::ffff:1.1.1.1",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "2002:808:808::",
  ])("%s is public", (ip) => expect(isNonPublicAddress(ip)).toBe(false));
});

describe("isNonPublicHostname", () => {
  it.each([
    "localhost",
    "api.localhost",
    "printer.local",
    "metadata.google.internal",
    "nas.home.arpa",
    "127.0.0.1",
    "[::1]",
    "[::ffff:a9fe:a9fe]",
    "64:ff9b::a9fe:a9fe",
  ])("%s is non-public", (h) => expect(isNonPublicHostname(h)).toBe(true));

  it("treats the hostname a URL parser produces for a mapped address as non-public", () => {
    const host = new URL("http://[::ffff:169.254.169.254]/latest").hostname;
    expect(isNonPublicHostname(host)).toBe(true);
    expect(
      isNonPublicHostname(
        new URL("http://[64:ff9b::169.254.169.254]/").hostname,
      ),
    ).toBe(true);
  });
  it.each(["example.com", "localhost.example.com", "8.8.8.8"])(
    "%s is not known to be non-public",
    (h) => expect(isNonPublicHostname(h)).toBe(false),
  );
});

describe("resolvesToNonPublic", () => {
  it("catches a public-looking name that resolves to a private address", async () => {
    expect(
      await resolvesToNonPublic("evil.example", async () => ["10.0.0.5"]),
    ).toBe(true);
  });
  it("passes a name that resolves only to public addresses", async () => {
    expect(
      await resolvesToNonPublic("example.com", async () => ["93.184.215.14"]),
    ).toBe(false);
  });
  it("does not treat an unresolvable name as non-public", async () => {
    expect(
      await resolvesToNonPublic("nope.invalid", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBe(false);
  });

  it("pins the first resolution so a later lookup cannot change it", async () => {
    let calls = 0;
    setHostResolver(async () => {
      calls += 1;
      return calls === 1 ? ["8.8.8.8"] : ["10.0.0.5"];
    });
    try {
      const first = await classifyHost("rebind.test");
      const second = await classifyHost("rebind.test");
      expect(first).toEqual({ addresses: ["8.8.8.8"], nonPublic: false });
      expect(second.addresses).toEqual(["8.8.8.8"]);
      expect(calls).toBe(1);
      const lookedUp = await new Promise<string>((resolve, reject) => {
        pinnedLookup(second.addresses)("rebind.test", {}, (err, address) => {
          if (err) reject(err);
          else resolve(String(address));
        });
      });
      expect(lookedUp).toBe("8.8.8.8");
    } finally {
      setHostResolver(undefined);
      clearPinnedHosts();
    }
  });
});
