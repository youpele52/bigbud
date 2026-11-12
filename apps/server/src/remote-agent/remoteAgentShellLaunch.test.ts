import { describe, expect, it } from "vitest";
import { shellProfileId } from "../terminal/Layers/ShellProfiles.identity.ts";
import { parseRemoteAgentOwner } from "./remoteAgentOwners.ts";
import { restartFixtureBinding } from "./remoteAgentOwners.restart.binding.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import {
  parseRemoteAgentShellLaunch,
  remoteAgentPtyRequestDigest,
  type RemoteAgentShellLaunch,
} from "./remoteAgentShellLaunch.ts";

const host = { kind: "agent", hostId: "agent:example" } as const;
function launch(args: readonly string[] = ["-l"]): RemoteAgentShellLaunch {
  return {
    version: 1,
    cwd: "/workspace",
    requestedProfile: {
      host,
      profileId: shellProfileId(host, "/bin/zsh", args, "linux"),
      kind: "zsh",
    },
    executable: "/bin/zsh",
    args,
    platform: "linux",
    integration: "disabled",
  };
}
const target = "ssh:example";
const digest = (shellLaunch?: RemoteAgentShellLaunch) =>
  Buffer.from(
    remoteAgentPtyRequestDigest({
      target,
      cwd: "/workspace",
      ...(shellLaunch ? { shellLaunch } : {}),
    }),
  ).toString("hex");
function owner(shellLaunch?: RemoteAgentShellLaunch) {
  const binding = restartFixtureBinding("g1");
  return {
    ownerKey: "terminal:example",
    target,
    connectionId: "connection-1",
    runtime: binding.runtime,
    epoch: binding.expectedEpoch,
    resourceId: "pty-1",
    digest: digest(shellLaunch),
    ...(shellLaunch ? { shellLaunch } : {}),
    state: "outcome-unknown",
    outputSequence: 0,
    nextInputSequence: 1,
    inputAcknowledged: 0,
  };
}

describe("versioned remote shell launch ownership", () => {
  it("preserves legacy target/cwd digest and owners without inventing a profile", () => {
    expect(digest()).toBe(
      Buffer.from(remoteAgentRequestDigest({ target, cwd: "/workspace" })).toString("hex"),
    );
    const decoded = parseRemoteAgentOwner(JSON.stringify(owner()));
    expect(Object.hasOwn(decoded, "shellLaunch")).toBe(false);
  });

  it("roundtrips immutable intent, not actual identity or suggestion readiness", () => {
    const input = owner(launch());
    for (const state of ["prepared", "may-have-been-sent", "outcome-unknown", "terminal"]) {
      const decoded = parseRemoteAgentOwner(JSON.stringify({ ...input, state }));
      expect(decoded.shellLaunch).toEqual(input.shellLaunch);
      expect(decoded.shellLaunch?.integration).toBe("disabled");
      expect(Object.hasOwn(decoded, "shellLaunchIdentity")).toBe(false);
    }
  });

  it("uses a distinct digest for profile-only launches and binds executable argv and host", () => {
    const selected = launch();
    expect(digest(selected)).not.toBe(digest());
    expect(digest(launch(["-f"]))).not.toBe(digest(selected));
    const otherHost = { kind: "agent", hostId: "agent:other" } as const;
    expect(
      digest({
        ...selected,
        requestedProfile: {
          ...selected.requestedProfile,
          host: otherHost,
          profileId: shellProfileId(otherHost, selected.executable, selected.args, "linux"),
        },
      }),
    ).not.toBe(digest(selected));
    const otherExecutable = "/usr/bin/zsh";
    expect(
      digest({
        ...selected,
        executable: otherExecutable,
        requestedProfile: {
          ...selected.requestedProfile,
          profileId: shellProfileId(host, otherExecutable, selected.args, "linux"),
        },
      }),
    ).not.toBe(digest(selected));
  });

  it("canonicalizes field order after persistence without consulting defaults", () => {
    const selected = launch();
    const reordered = {
      ...selected,
      requestedProfile: {
        kind: selected.requestedProfile.kind,
        profileId: selected.requestedProfile.profileId,
        host: { hostId: host.hostId, kind: host.kind },
      },
    };
    expect(digest(reordered)).toBe(digest(selected));
    expect(digest(parseRemoteAgentOwner(JSON.stringify(owner(reordered))).shellLaunch)).toBe(
      digest(selected),
    );
  });

  it("detects modified intent even when a record still has a well-formed digest", () => {
    const original = owner(launch());
    for (const tampered of [
      { ...original, target: "ssh:other" },
      { ...original, shellLaunch: launch(["-f"]) },
      { ...original, shellLaunch: { ...launch(), cwd: "/other" } },
      { ...original, digest: digest() },
      { ...original, ownerKey: "tool:example" },
    ]) {
      expect(() => parseRemoteAgentOwner(JSON.stringify(tampered))).toThrow();
    }
  });

  it("rejects unsupported versions, integrations, local scopes and mismatched profile IDs", () => {
    const selected = launch();
    for (const invalid of [
      { ...selected, version: 2 },
      { ...selected, integration: "qualified-history" },
      { ...selected, executable: "/bin/bash" },
      { ...selected, args: ["-f"] },
      { ...selected, platform: "win32" },
      { ...selected, requestedProfile: { ...selected.requestedProfile, kind: "bash" } },
      {
        ...selected,
        requestedProfile: {
          ...selected.requestedProfile,
          host: { kind: "local", hostId: "local" },
        },
      },
      {
        ...selected,
        platform: "darwin",
        requestedProfile: {
          ...selected.requestedProfile,
          host: { kind: "wsl", hostId: "wsl:example", distribution: "Ubuntu", username: "user" },
        },
      },
    ]) {
      expect(() => parseRemoteAgentShellLaunch(invalid)).toThrow();
    }
  });

  it("bounds the full intent and owner, not just individual argument lengths", () => {
    expect(() => parseRemoteAgentShellLaunch(launch(["x".repeat(4096), "y".repeat(4096)]))).toThrow(
      "too large",
    );
    expect(() => parseRemoteAgentShellLaunch(launch(Array(33).fill("-l")))).toThrow();
    expect(() =>
      parseRemoteAgentOwner(JSON.stringify({ ...owner(), padding: "x".repeat(16384) })),
    ).toThrow("too large");
  });

  it.each(["relative", "/bad\npath", "/bad\rpath", "/bad\0path"])(
    "rejects invalid destination cwd %j",
    (cwd) => expect(() => parseRemoteAgentShellLaunch({ ...launch(), cwd })).toThrow(),
  );

  it("requires the same cwd in the dispatch and persisted intent", () => {
    expect(() =>
      remoteAgentPtyRequestDigest({ target, cwd: "/other", shellLaunch: launch() }),
    ).toThrow("cwd does not match");
  });
});
