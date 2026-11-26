import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverRemoteShellProfiles } from "./ShellProfiles.remote";
import { remoteShellHost, RemoteShellDiscoveryError } from "./ShellProfiles.remote.identity";
import { inventory, result } from "./ShellProfiles.remote.test.helpers";
import {
  REMOTE_SHELL_OUTPUT_BYTES,
  REMOTE_SHELL_PROBE_SCRIPT,
} from "./ShellProfiles.remote.protocol";

const ssh = { executionTargetId: "ssh:host=example.test&user=alice" };
const identity = { distribution: "Linux 日本語", username: "alice", uid: 1000 };
const wsl = {
  executionTargetId: `wsl:${encodeURIComponent(identity.distribution)}`,
  wslIdentity: identity,
};

// These cases exercise legacy targets explicitly configured for direct SSH.
beforeEach(() => vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "direct-ssh"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("remote shell host identity", () => {
  it("hashes canonical SSH account/target without exposing connection details", () => {
    const host = remoteShellHost(ssh);
    expect(host).toEqual({ kind: "ssh", hostId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(remoteShellHost({ executionTargetId: "ssh:alice@EXAMPLE.test" })).toEqual(host);
    expect(
      remoteShellHost({
        executionTargetId: "ssh:port=022&user=alice&host=example.test&auth=password",
      }),
    ).toEqual(host);
    expect(
      remoteShellHost({ executionTargetId: `${ssh.executionTargetId}&keyPath=%2Fprivate%2Fkey` }),
    ).toEqual(host);
    expect(remoteShellHost({ executionTargetId: "ssh:host=example.test&user=bob" })).not.toEqual(
      host,
    );
    expect(remoteShellHost({ executionTargetId: "ssh:host=other.test&user=alice" })).not.toEqual(
      host,
    );
    expect(
      remoteShellHost({ executionTargetId: `${ssh.executionTargetId}&port=2222` }),
    ).not.toEqual(host);
  });

  it("isolates WSL distributions/users and matches the pinned target", () => {
    const host = remoteShellHost(wsl);
    expect(host).toMatchObject({
      kind: "wsl",
      distribution: identity.distribution,
      username: "alice",
    });
    expect(remoteShellHost({ ...wsl, wslIdentity: { ...identity, username: "bob" } })).not.toEqual(
      host,
    );
    const other = { ...identity, distribution: "Other" };
    expect(remoteShellHost({ executionTargetId: "wsl:Other", wslIdentity: other })).not.toEqual(
      host,
    );
    expect(() => remoteShellHost({ ...wsl, wslIdentity: other })).toThrow(
      RemoteShellDiscoveryError,
    );
  });

  it.each([
    { executionTargetId: "local" },
    { executionTargetId: "agent:host" },
    { executionTargetId: "ssh:host=x&transport=agent" },
    { executionTargetId: "ssh:" },
    { executionTargetId: "ssh:example.test" },
    { executionTargetId: "ssh:host=example.test" },
    { executionTargetId: "ssh:host=example.test&user=" },
    { executionTargetId: "ssh:@example.test" },
    { executionTargetId: "ssh:host=x&port=0&user=alice" },
    { executionTargetId: "ssh:host=x&port=65536&user=alice" },
    { executionTargetId: "ssh:host=x%0Abanner&user=alice" },
    { executionTargetId: "ssh:alice@-option" },
    { executionTargetId: "ssh:host=x&user=-option" },
    { executionTargetId: "ssh:host=x&user=%00" },
    { executionTargetId: "wsl:Linux%0A" },
    {
      executionTargetId: "wsl:%4cinux",
      wslIdentity: { distribution: "Linux", username: "alice", uid: 1000 },
    },
    { executionTargetId: "wsl:Linux" },
    { ...wsl, wslIdentity: { ...identity, uid: -1 } },
    { ...wsl, wslIdentity: { ...identity, uid: Number.NaN } },
    { ...wsl, wslIdentity: { ...identity, username: "a\nb" } },
    { ...ssh, wslIdentity: identity },
  ])("rejects unsupported or malformed identity %# without transport", async (input) => {
    expect(() => remoteShellHost(input)).toThrow(RemoteShellDiscoveryError);
    const runWslProcess = vi.fn(async () => result());
    const error = await Effect.runPromise(
      discoverRemoteShellProfiles(input, { runWslProcess }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("unsupported-target");
    expect(runWslProcess).not.toHaveBeenCalled();
  });
});

describe("bounded execution-host shell discovery", () => {
  it("pins WSL distro, user, UID argv and clean environment; decodes guest UTF-8, never UTF-16", async () => {
    const runWslProcess = vi.fn(async () =>
      result({
        stdout: Buffer.from(inventory([["/bin/zsh", "/日本 語/zsh"]]), "utf8").toString("latin1"),
      }),
    );
    const profiles = await Effect.runPromise(
      discoverRemoteShellProfiles(wsl, { platform: "win32", runWslProcess }),
    );
    expect(profiles[0]?.executable).toBe("/日本 語/zsh");
    expect(profiles[0]?.host).toEqual(remoteShellHost(wsl));
    expect(runWslProcess).toHaveBeenCalledWith(
      [
        "--distribution",
        identity.distribution,
        "--user",
        "alice",
        "--exec",
        "/usr/bin/env",
        "/bin/sh",
        "-c",
        expect.stringContaining("exec /usr/bin/env -i"),
        "sh",
        REMOTE_SHELL_PROBE_SCRIPT,
        "wsl",
        "alice",
        "1000",
      ],
      {
        signal: expect.any(AbortSignal),
        timeoutMs: 10000,
        maxBufferBytes: REMOTE_SHELL_OUTPUT_BYTES,
        outputMode: "error",
      },
    );
  });
});
