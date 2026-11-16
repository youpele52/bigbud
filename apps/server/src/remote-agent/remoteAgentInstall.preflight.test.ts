import { describe, expect, it } from "vitest";
import {
  assertRemoteAgentPreflight,
  buildRemoteAgentPreflightScript,
  parseRemoteAgentPreflight,
} from "./remoteAgentInstall.preflight.ts";
import { parseRemoteAgentPlatformProbe } from "./remoteAgentPlatform.ts";

const healthy = [
  "libc=ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35 Copyright (C) 2022 Free Software Foundation, Inc.",
  ...["sha256sum", "flock", "base64", "mktemp", "awk", "install", "stat", "readlink", "sync"].map(
    (tool) => `tool.${tool}=yes`,
  ),
  "feature.stat-c=yes",
  "feature.readlink-f=yes",
  "feature.sync-f=yes",
  "dir..bigbud/agent=mode=700,owner=self",
  "dir..bigbud/agent/bin=absent",
];

describe("remote agent install preflight", () => {
  it("accepts a healthy glibc host", () => {
    const report = parseRemoteAgentPreflight(healthy);
    expect(report.libc).toEqual({ family: "glibc", version: "2.35" });
    expect(report.missingTools).toEqual([]);
    expect(() => assertRemoteAgentPreflight(report)).not.toThrow();
  });

  it("never refuses on an assumed libc floor; the real --check decides", () => {
    const old = parseRemoteAgentPreflight([
      ...healthy.slice(1),
      "libc=ldd (Ubuntu GLIBC 2.31-0ubuntu9.16) 2.31 Copyright (C) 2020 Free Software Foundation, Inc.",
    ]);
    expect(old.libc).toEqual({ family: "glibc", version: "2.31" });
    expect(() => assertRemoteAgentPreflight(old)).not.toThrow();
    const musl = parseRemoteAgentPreflight([
      ...healthy.slice(1),
      "libc=musl libc (x86_64) Version 1.2.4 ",
    ]);
    expect(musl.libc).toEqual({ family: "musl", version: "1.2.4" });
    expect(() => assertRemoteAgentPreflight(musl)).not.toThrow();
    const unknown = parseRemoteAgentPreflight([...healthy.slice(1), "libc=missing"]);
    expect(unknown.libc.family).toBe("unknown");
    expect(() => assertRemoteAgentPreflight(unknown)).not.toThrow();
  });

  it("reports missing tools once and unsafe directories", () => {
    const report = parseRemoteAgentPreflight([
      ...healthy,
      "tool.flock=no",
      "tool.stat=no",
      "feature.stat-c=no",
      "feature.readlink-f=no",
      "dir..bigbud/agent=mode=755,owner=self",
    ]);
    expect(report.missingTools).toEqual(["flock", "stat", "readlink -f"]);
    expect(() => assertRemoteAgentPreflight(report)).toThrow("flock, stat, readlink -f");
    const directories = parseRemoteAgentPreflight([
      ...healthy,
      "dir..bigbud/agent=mode=755,owner=self",
    ]);
    expect(() => assertRemoteAgentPreflight(directories)).toThrow("chmod 700 ~/.bigbud/agent");
  });

  it("is parsed from the platform probe and omitted for legacy two-line output", () => {
    const platform = parseRemoteAgentPlatformProbe(["Linux", "x86_64", ...healthy].join("\n"));
    expect(platform.preflight?.libc.version).toBe("2.35");
    expect(parseRemoteAgentPlatformProbe("Linux\nx86_64\n").preflight).toBeUndefined();
  });

  it("never prints the account's home path or executes downloaded content", () => {
    const script = buildRemoteAgentPreflightScript();
    expect(script).not.toMatch(/\.bigbud\/agent\/bin\/[^ ]*bigbud-remote-agent/);
    expect(script).toContain("printf 'dir.%s=");
    expect(script).not.toContain("printf 'dir.%s=%s' \"$path\"");
  });
});
