import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverRemoteShellProfiles,
  type RemoteShellDiscoveryDependencies,
} from "./ShellProfiles.remote";
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
const discover = (dependencies: RemoteShellDiscoveryDependencies = {}) =>
  discoverRemoteShellProfiles(ssh, dependencies);
const failure = (dependencies: RemoteShellDiscoveryDependencies) =>
  Effect.runPromise(discover(dependencies).pipe(Effect.flip));

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
    const runSshCommand = vi.fn(async () => result());
    const runWslProcess = vi.fn(async () => result());
    const error = await Effect.runPromise(
      discoverRemoteShellProfiles(input, { runSshCommand, runWslProcess }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("unsupported-target");
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(runWslProcess).not.toHaveBeenCalled();
  });
});

describe("bounded execution-host shell discovery", () => {
  it("uses authenticated SSH helper with static source, strict bounds, signal and no workspace context", async () => {
    const runSshCommand = vi.fn(async () => result());
    const profiles = await Effect.runPromise(discover({ runSshCommand }));
    expect(profiles[0]?.host).toEqual(remoteShellHost(ssh));
    const invocation = runSshCommand.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(invocation[0]).toEqual({
      executionTargetId: ssh.executionTargetId,
      command: "/usr/bin/env",
      args: [
        "-i",
        "PATH=/usr/bin:/bin",
        "LC_ALL=C",
        "/bin/sh",
        "-c",
        REMOTE_SHELL_PROBE_SCRIPT,
        "sh",
        "ssh",
        "alice",
      ],
      signal: expect.any(AbortSignal),
      allocateTty: false,
      shellMode: "clean-posix",
      allowNonZeroExit: true,
      timeoutMs: 10000,
      maxBufferBytes: REMOTE_SHELL_OUTPUT_BYTES,
      outputMode: "error",
    });
  });

  it("passes the legacy user as argv without interpolating shell-like account text", async () => {
    const username = "alice'$(not-source)";
    const runSshCommand = vi.fn(async () => result());
    await Effect.runPromise(
      discoverRemoteShellProfiles(
        {
          executionTargetId: `ssh:${username}@example.test`,
        },
        { runSshCommand },
      ),
    );
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "-i",
          "PATH=/usr/bin:/bin",
          "LC_ALL=C",
          "/bin/sh",
          "-c",
          REMOTE_SHELL_PROBE_SCRIPT,
          "sh",
          "ssh",
          username,
        ],
      }),
    );
    expect(REMOTE_SHELL_PROBE_SCRIPT).not.toContain(username);
  });

  it("keeps profile IDs host/account scoped with identical executables", async () => {
    const dependencies = { runSshCommand: async () => result() };
    const left = await Effect.runPromise(discover(dependencies));
    const right = await Effect.runPromise(
      discoverRemoteShellProfiles({ executionTargetId: "ssh:bob@example.test" }, dependencies),
    );
    expect(left[0]?.profileId).not.toBe(right[0]?.profileId);
  });

  it.each([
    { code: 79 },
    { code: null },
    { signal: "SIGTERM" as const },
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { stdout: "startup noise\n" + inventory() },
    { stdout: "" },
    { stdout: inventory().slice(0, -1) },
    { stdout: "x".repeat(REMOTE_SHELL_OUTPUT_BYTES + 1) },
    { stderr: "x".repeat(REMOTE_SHELL_OUTPUT_BYTES + 1) },
  ])("does not turn transport/protocol failure %# into empty success", async (overrides) => {
    const error = await failure({ runSshCommand: async () => result(overrides) });
    expect(error).toBeInstanceOf(RemoteShellDiscoveryError);
    expect(error.reason).toBe("probe-failed");
    expect(Object.keys(error)).not.toContain("stdout");
  });

  it("maps process timeout and trust/auth failures to bounded reasons only", async () => {
    expect((await failure({ runSshCommand: async () => result({ timedOut: true }) })).reason).toBe(
      "timed-out",
    );
    for (const message of [
      "Process execution timed out.",
      "private host key failure",
      "private auth failure",
    ]) {
      const error = await failure({
        runSshCommand: async () => {
          throw new Error(message);
        },
      });
      expect(error.reason).toBe(message.includes("timed out") ? "timed-out" : "probe-failed");
      expect(JSON.stringify(error)).not.toContain("private");
    }
  });

  it.each(["ssh", "wsl"])(
    "enforces the overall %s deadline even if transport never settles",
    async (kind) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const operation = discoverRemoteShellProfiles(kind === "ssh" ? ssh : wsl, {
        platform: "win32",
        runSshCommand: (input) => {
          signal = input.signal;
          return new Promise(() => {});
        },
        runWslProcess: (_args, options) => {
          signal = options?.signal;
          return new Promise(() => {});
        },
      });
      const pending = Effect.runPromise(operation.pipe(Effect.flip));
      await vi.advanceTimersByTimeAsync(10001);
      expect((await pending).reason).toBe("timed-out");
      expect(signal?.aborted).toBe(true);
    },
  );

  it.each(["ssh", "wsl"])("forwards Effect interruption to the %s transport", async (kind) => {
    let started!: (signal: AbortSignal) => void;
    const ready = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const fiber = Effect.runFork(
      discoverRemoteShellProfiles(kind === "ssh" ? ssh : wsl, {
        platform: "win32",
        runSshCommand: (input) => {
          started(input.signal!);
          return new Promise(() => {});
        },
        runWslProcess: (_args, options) => {
          started(options!.signal!);
          return new Promise(() => {});
        },
      }),
    );
    const signal = await ready;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal.aborted).toBe(true);
  });

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

  it("fails WSL UID mismatch, malformed UTF-8 and non-Windows support without SSH fallback", async () => {
    const runSshCommand = vi.fn(async () => result());
    for (const response of [
      result({ code: 79 }),
      result({ stdout: "\xff" }),
      result({ stdout: "\xef\xbb\xbf" + inventory() }),
      result({ stdout: "\xff\xfe" + inventory() }),
      result({ timedOut: true }),
      result({ stdoutTruncated: true }),
    ]) {
      const error = await Effect.runPromise(
        discoverRemoteShellProfiles(wsl, {
          platform: "win32",
          runWslProcess: async () => response,
          runSshCommand,
        }).pipe(Effect.flip),
      );
      expect(error.reason).toBe(response.timedOut ? "timed-out" : "probe-failed");
    }
    const runWslProcess = vi.fn(async () => result());
    const error = await Effect.runPromise(
      discoverRemoteShellProfiles(wsl, { platform: "darwin", runWslProcess, runSshCommand }).pipe(
        Effect.flip,
      ),
    );
    expect(error.reason).toBe("unsupported-target");
    expect(runWslProcess).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});
