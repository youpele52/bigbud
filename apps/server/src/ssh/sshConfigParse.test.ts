import { describe, expect, it } from "vitest";

import { parseSshConfig, tokenizeSshConfigLine } from "./sshConfigParse.ts";

describe("tokenizeSshConfigLine", () => {
  it("accepts key=value, quoted arguments, and trailing comments", () => {
    expect(tokenizeSshConfigLine("  HostName=10.0.0.1")).toEqual({
      keyword: "hostname",
      args: ["10.0.0.1"],
    });
    expect(tokenizeSshConfigLine('Include "~/my configs/*" other # note')).toEqual({
      keyword: "include",
      args: ["~/my configs/*", "other"],
    });
    expect(tokenizeSshConfigLine("Port = 2222")).toEqual({ keyword: "port", args: ["2222"] });
  });

  it("ignores blank and comment lines", () => {
    expect(tokenizeSshConfigLine("   ")).toBeNull();
    expect(tokenizeSshConfigLine("  # Host commented")).toBeNull();
  });
});

describe("parseSshConfig", () => {
  it("lists concrete aliases with block-scoped hints in file order", () => {
    const items = parseSshConfig(
      [
        "﻿User global-user",
        "HOST work-server staging",
        "  HostName 10.0.4.7",
        "  user deploy",
        "  Port 2222",
        "  Port 3333",
        "",
        "Host gpu-box",
        "  HostName gpu.lab.internal",
      ].join("\r\n"),
    );

    expect(items).toEqual([
      {
        kind: "host",
        alias: "work-server",
        line: 2,
        hostName: "10.0.4.7",
        user: "deploy",
        port: "2222",
      },
      {
        kind: "host",
        alias: "staging",
        line: 2,
        hostName: "10.0.4.7",
        user: "deploy",
        port: "2222",
      },
      { kind: "host", alias: "gpu-box", line: 8, hostName: "gpu.lab.internal" },
    ]);
  });

  it("excludes wildcard and negated patterns and ignores Match blocks", () => {
    const items = parseSshConfig(
      [
        "Host * !bastion *.internal db-?",
        "  User everyone",
        "Host bastion",
        'Match host bastion exec "true"',
        "  HostName should-not-apply",
        "  Include matched.conf",
      ].join("\n"),
    );

    expect(items).toEqual([
      { kind: "host", alias: "bastion", line: 3 },
      { kind: "include", patterns: ["matched.conf"], line: 6 },
    ]);
  });

  it("keeps Include position relative to hosts", () => {
    const items = parseSshConfig(["Include config.d/*", "Host after"].join("\n"));
    expect(items.map((item) => item.kind)).toEqual(["include", "host"]);
  });
});
