import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  TerminalShellProfileInventory,
  TerminalShellProfilesInput,
} from "./terminal.shellProfiles";

const host = { kind: "ssh", hostId: "fixture" } as const;
const profile = {
  profileId: "fixture:zsh",
  host,
  kind: "zsh",
  displayName: "zsh",
  executable: "/usr/bin/zsh",
  args: ["-o", "nopromptsp"],
  platform: "linux",
  availability: "available",
  integration: { status: "disabled" },
} as const;
const valid = (input: unknown) => Schema.is(TerminalShellProfileInventory)(input);

describe("existing-pane shell inventory contracts", () => {
  it("requires both pane identifiers and admits no launch authority", () => {
    const decode = Schema.decodeUnknownSync(TerminalShellProfilesInput);
    expect(
      decode({
        threadId: "t",
        terminalId: "p",
        executionTargetId: "local",
        executable: "/bin/sh",
        args: ["-c", "bad"],
      }),
    ).toEqual({ threadId: "t", terminalId: "p" });
    for (const input of [
      { threadId: "t" },
      { terminalId: "p" },
      { threadId: "", terminalId: "p" },
      { threadId: "t", terminalId: "x".repeat(129) },
    ]) {
      expect(Schema.is(TerminalShellProfilesInput)(input)).toBe(false);
    }
  });
  it("accepts empty and complete bounded inventories", () => {
    expect(valid({ host, profiles: [] })).toBe(true);
    expect(valid({ host, profiles: [profile] })).toBe(true);
    const profiles = Array.from({ length: 64 }, (_, i) => ({
      ...profile,
      profileId: `fixture:${i}`,
    }));
    expect(valid({ host, profiles })).toBe(true);
    expect(valid({ host, profiles: [...profiles, { ...profile, profileId: "overflow" }] })).toBe(
      false,
    );
  });
  it("rejects duplicate IDs and cross-host or cross-kind entries as a whole", () => {
    expect(valid({ host, profiles: [profile, profile] })).toBe(false);
    for (const wrong of [
      { kind: "local", hostId: "fixture" },
      { ...host, hostId: "other" },
    ]) {
      expect(
        valid({ host, profiles: [profile, { ...profile, profileId: "other", host: wrong }] }),
      ).toBe(false);
    }
  });
  it("requires the same pinned WSL distribution and username on every entry", () => {
    const wsl = { kind: "wsl", hostId: "wsl", distribution: "Ubuntu", username: "user" } as const;
    expect(valid({ host: wsl, profiles: [{ ...profile, host: wsl }] })).toBe(true);
    for (const wrong of [
      { ...wsl, distribution: "Other" },
      { ...wsl, username: "other" },
    ]) {
      expect(valid({ host: wsl, profiles: [{ ...profile, host: wrong }] })).toBe(false);
    }
  });
  it("does not admit malformed profile payloads", () => {
    expect(valid({ host, profiles: [{ ...profile, executable: "\u001b[31m" }] })).toBe(false);
    expect(valid({ host, profiles: [{ ...profile, args: Array(33).fill("x") }] })).toBe(false);
    expect(valid({ host, profiles: [null] })).toBe(false);
  });
});
