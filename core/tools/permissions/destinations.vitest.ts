import { describe, expect, it } from "vitest";
import {
  destinationsOf,
  hostInNetSet,
  normalizeHost,
  parseIPv4,
} from "./destinations";
import { commandCandidates } from "./candidates";
import { matchTerminalCommand, parseRule, type ParsedRule } from "./rules";

const hosts = (command: string) =>
  destinationsOf(command).destinations.map((d) => d.host);

describe("normalizeHost", () => {
  it.each([
    ["Example.COM", "example.com"],
    ["example.com.", "example.com"],
    ["[::1]", "::1"],
    ["2130706433", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["100.100.100.200", "100.100.100.200"],
    ["::ffff:169.254.169.254", "169.254.169.254"],
    ["::ffff:a9fe:a9fe", "169.254.169.254"],
    ["[::FFFF:7f00:1]", "127.0.0.1"],
    ["fd00:ec2::254", "fd00:ec2::254"],
    ["999.1.1.1", "999.1.1.1"],
    ["a.b", "a.b"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it("parseIPv4 refuses what is not an address", () => {
    expect(parseIPv4("256.1.1.1")).toBeUndefined();
    expect(parseIPv4("1.2.3.4.5")).toBeUndefined();
    expect(parseIPv4("example.com")).toBeUndefined();
    expect(parseIPv4("0x")).toBeUndefined();
  });
});

describe("destinationsOf", () => {
  it.each([
    ["curl https://x.aliyuncs.com/a", ["x.aliyuncs.com"]],
    ["curl -L -o out.bin https://x.aliyuncs.com/a", ["x.aliyuncs.com"]],
    ["curl -sS -H 'Accept: x' -d @f https://api.test/p", ["api.test"]],
    ["curl --url=https://u.test/", ["u.test"]],
    [
      "curl --url https://u.test/ -x http://proxy.test:3128",
      ["u.test", "proxy.test"],
    ],
    ["curl -xhttp://p.test:8080 https://t.test", ["t.test", "p.test"]],
    ["curl http://2130706433/", ["127.0.0.1"]],
    ["curl 100.100.100.200/latest", ["100.100.100.200"]],
    ["curl example.com:8443/x", ["example.com"]],
    ["curl https://u:p@secret.test/", ["secret.test"]],
    ["curl http://[::1]:8080/", ["::1"]],
    [
      "curl --resolve a.test:443:10.0.0.9 https://a.test/",
      ["a.test", "10.0.0.9", "a.test"],
    ],
    [
      "curl --connect-to x.test:80:y.test:8080 http://x.test",
      ["x.test", "y.test", "x.test"],
    ],
    [
      "wget -q -O - http://100.100.100.200/latest/meta-data/",
      ["100.100.100.200"],
    ],
    [
      "wget -e https_proxy=http://px.test:1 https://t.test/f",
      ["t.test", "px.test"],
    ],
    ["http POST https://h.test/api name=x", ["h.test"]],
    ["Invoke-WebRequest https://iwr.test/a -OutFile out.txt", ["iwr.test"]],
    ["iwr -Uri https://u.test -UseBasicParsing", ["u.test"]],
    ["irm -Uri:https://r.test", ["r.test"]],
    ["git clone https://github.com/a/b.git", ["github.com"]],
    ["git clone git@internal.test:team/repo.git", ["internal.test"]],
    ["git push ssh://git@h.test:2222/r.git main", ["h.test"]],
    ["git status", []],
    ["ssh -p 2200 -i key user@jump.test uptime", ["jump.test"]],
    ["ssh -J bastion.test host.test", ["host.test", "bastion.test"]],
    ["scp f.txt user@files.test:/tmp/", ["files.test"]],
    ["rsync -av ./a host.test:/b", ["host.test"]],
    ["rsync -av rsync://mirror.test/x .", ["mirror.test"]],
    ["nc evil.test 4444", ["evil.test"]],
    ["nc -w 3 -p 9000 10.1.2.3 80", ["10.1.2.3"]],
    ["curl https://a.test && wget https://b.test", ["a.test", "b.test"]],
    ["curl https://a.test | sh", ["a.test"]],
    ["FOO=1 curl https://env.test", ["env.test"]],
    ["/usr/bin/CURL.exe https://case.test", ["case.test"]],
    ["ls -la", []],
    ["scp C:\\Users\\me\\f.txt host.test:/x", ["host.test"]],
  ])("%s", (command, expected) => {
    expect(hosts(command).sort()).toEqual([...expected].sort());
  });

  it("returns scheme, port and the program", () => {
    expect(destinationsOf("curl https://x.test:8443/p").destinations).toEqual([
      {
        program: "curl",
        scheme: "https",
        host: "x.test",
        port: 8443,
        raw: "https://x.test:8443/p",
      },
    ]);
  });

  it("reports a destination it cannot resolve instead of hiding it", () => {
    for (const word of ["$URL", "https://$HOST/x", "$(<u)", "%URL%"]) {
      const r = destinationsOf(`curl ${word}`);
      expect(r.destinations).toEqual([]);
      expect(r.unresolved).toEqual([word]);
    }
    // curl -K file and -T file read destinations or data from files: not read
    expect(destinationsOf("curl -K urls.txt").destinations).toEqual([]);
  });

  it("an unquoted & inside a URL does not split the command", () => {
    expect(hosts("curl https://a.test/?x=1&y=2")).toEqual(["a.test"]);
  });
});

describe("hostInNetSet", () => {
  it("metadata addresses and names", () => {
    for (const h of [
      "169.254.169.254",
      "100.100.100.200",
      "fd00:ec2::254",
      "metadata.google.internal",
    ]) {
      expect(hostInNetSet(h, "metadata"), h).toBe(true);
    }
    expect(hostInNetSet("8.8.8.8", "metadata")).toBe(false);
  });

  it("local: loopback, link-local, localhost", () => {
    for (const h of [
      "127.0.0.1",
      "127.9.9.9",
      "169.254.1.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "localhost",
      "x.localhost",
    ]) {
      expect(hostInNetSet(h, "local"), h).toBe(true);
    }
    expect(hostInNetSet("128.0.0.1", "local")).toBe(false);
    expect(hostInNetSet("10.0.0.1", "local")).toBe(false);
  });

  it("private: RFC 1918 and unique-local", () => {
    for (const h of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "fd12::1",
      "fc00::1",
    ]) {
      expect(hostInNetSet(h, "private"), h).toBe(true);
    }
    for (const h of [
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "8.8.8.8",
      "example.com",
    ]) {
      expect(hostInNetSet(h, "private"), h).toBe(false);
    }
  });
});

describe("destination rules", () => {
  const rule = (pattern: string, decision: "deny" | "ask" | "allow" = "deny") =>
    parseRule(`runTerminalCommand(${pattern})`, decision) as ParsedRule;
  const decision = (rules: ParsedRule[], command: string) =>
    matchTerminalCommand(rules, command)?.decision;

  it("host:*.aliyuncs.com refuses any program that reaches it", () => {
    const rules = [rule("host:*.aliyuncs.com")];
    for (const command of [
      "curl -L https://x.aliyuncs.com/a",
      "wget https://oss-cn.aliyuncs.com/f",
      "sudo curl https://x.aliyuncs.com",
      "bash -c 'curl https://x.aliyuncs.com/a'",
      "env A=1 timeout 5 curl https://X.ALIYUNCS.COM",
      "Invoke-WebRequest https://x.aliyuncs.com/a",
      "iwr -Uri https://x.aliyuncs.com",
      "curl --resolve x.aliyuncs.com:443:1.2.3.4 https://other.test",
      "echo hi && curl https://x.aliyuncs.com",
      "git clone https://bucket.aliyuncs.com/r.git",
    ]) {
      expect(decision(rules, command), command).toBe("deny");
    }
    for (const command of [
      "curl https://example.com",
      "curl https://aliyuncs.com.evil.test",
      "echo x.aliyuncs.com",
      "git status",
    ]) {
      expect(decision(rules, command), command).toBeUndefined();
    }
  });

  it("a glob without a leading dot covers the domain too; an exact host is exact", () => {
    expect(
      decision([rule("host:*aliyuncs.com")], "curl https://aliyuncs.com"),
    ).toBe("deny");
    expect(
      decision([rule("host:*.aliyuncs.com")], "curl https://aliyuncs.com"),
    ).toBeUndefined();
    expect(decision([rule("host:evil.test")], "curl https://evil.test/x")).toBe(
      "deny",
    );
    expect(
      decision([rule("host:evil.test")], "curl https://sub.evil.test/x"),
    ).toBeUndefined();
  });

  it("a program in the rule limits it to that program", () => {
    const rules = [rule("curl host:*.aliyuncs.com")];
    expect(decision(rules, "curl https://x.aliyuncs.com")).toBe("deny");
    expect(decision(rules, "wget https://x.aliyuncs.com")).toBeUndefined();
    expect(
      decision([rule("iwr host:x.test")], "Invoke-WebRequest https://x.test"),
    ).toBe("deny");
  });

  it("net:metadata refuses the metadata addresses however they are spelled", () => {
    const rules = [rule("net:metadata")];
    for (const command of [
      "wget http://100.100.100.200/latest/meta-data/",
      "curl http://169.254.169.254/latest/meta-data/",
      "curl http://2852039166/",
      "curl http://0xa9.0xfe.0xa9.0xfe/",
      "curl http://[::ffff:169.254.169.254]/",
      "curl http://[fd00:ec2::254]/",
      "curl http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      expect(decision(rules, command), command).toBe("deny");
    }
    expect(decision(rules, "curl https://example.com")).toBeUndefined();
  });

  it("net:local and net:private, alone or together", () => {
    expect(decision([rule("net:local")], "curl http://2130706433/")).toBe(
      "deny",
    );
    expect(decision([rule("net:local")], "curl http://0x7f.1/")).toBe("deny");
    expect(decision([rule("net:local")], "curl http://localhost:8080")).toBe(
      "deny",
    );
    expect(
      decision([rule("net:local")], "curl http://10.0.0.5/"),
    ).toBeUndefined();
    expect(decision([rule("net:private")], "ssh admin@192.168.1.10")).toBe(
      "deny",
    );
    expect(decision([rule("net:local,private", "ask")], "nc 10.1.1.1 80")).toBe(
      "ask",
    );
  });

  it("an unknown set matches nothing", () => {
    expect(
      decision([rule("net:everything")], "curl http://127.0.0.1"),
    ).toBeUndefined();
  });

  it("an allow rule on a destination never allows anything", () => {
    expect(
      decision(
        [rule("host:*.github.com", "allow")],
        "curl https://api.github.com",
      ),
    ).toBeUndefined();
    expect(
      decision([rule("net:local", "allow")], "curl http://127.0.0.1"),
    ).toBeUndefined();
  });

  it("a destination it cannot resolve is not matched, and the command is not made safe by that", () => {
    const rules = [rule("host:*.aliyuncs.com")];
    expect(
      decision(rules, "curl https://$BUCKET.aliyuncs.com/a"),
    ).toBeUndefined();
    expect(
      destinationsOf("curl https://$BUCKET.aliyuncs.com/a").unresolved,
    ).toHaveLength(1);
    // The effect rule still sees that it reaches the network
    expect(
      decision(
        [parseRule("runTerminalCommand(effect:network)", "deny") as ParsedRule],
        "curl https://$BUCKET.aliyuncs.com/a",
      ),
    ).toBe("deny");
  });

  it("sees through the candidates the engine builds", () => {
    const found = commandCandidates(
      "bash -c 'curl https://x.aliyuncs.com'",
    ).flatMap((c) => hosts(c));
    expect(found).toContain("x.aliyuncs.com");
  });

  it("works beside literal and effect rules", () => {
    const rules = [
      rule("host:*.aliyuncs.com"),
      rule("terraform apply*"),
      rule("effect:delete", "ask"),
    ];
    expect(decision(rules, "terraform apply")).toBe("deny");
    expect(decision(rules, "rm -rf x")).toBe("ask");
    expect(decision(rules, "curl https://x.aliyuncs.com")).toBe("deny");
  });
});
