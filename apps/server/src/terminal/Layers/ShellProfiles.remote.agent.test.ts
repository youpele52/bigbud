import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverRemoteShellProfiles } from "./ShellProfiles.remote";
import { remoteShellHost } from "./ShellProfiles.remote.identity";
import { inventory, result } from "./ShellProfiles.remote.test.helpers";
import { REMOTE_SHELL_PROBE_SCRIPT } from "./ShellProfiles.remote.protocol";

const legacy = "ssh:host=example.test&user=alice";
const agent = `${legacy}&transport=agent`;
const direct = `${legacy}&transport=direct-ssh`;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("authenticated agent-host inventory routing", () => {
  it.each([
    [agent, "direct-ssh"],
    [legacy, "agent"],
  ])("routes %s through the authenticated process lane", async (executionTargetId, transport) => {
    vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", transport);
    const runRemoteAgentShellInventory = vi.fn(async () => result());
    const runSshCommand = vi.fn(async () => result());
    const profiles = await Effect.runPromise(
      discoverRemoteShellProfiles(
        { executionTargetId },
        {
          runRemoteAgentShellInventory,
          runSshCommand,
        },
      ),
    );
    expect(profiles[0]?.host).toEqual(remoteShellHost({ executionTargetId: direct }));
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(runRemoteAgentShellInventory).toHaveBeenCalledExactlyOnceWith({
      executionTargetId,
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
      timeoutMs: 10000,
      maxBufferBytes: 8192,
    });
  });

  it("honors explicit direct SSH even with the legacy agent default", async () => {
    vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "agent");
    const runRemoteAgentShellInventory = vi.fn(async () => result());
    const runSshCommand = vi.fn(async () => result());
    await Effect.runPromise(
      discoverRemoteShellProfiles(
        { executionTargetId: direct },
        {
          runRemoteAgentShellInventory,
          runSshCommand,
        },
      ),
    );
    expect(runSshCommand).toHaveBeenCalledOnce();
    expect(runRemoteAgentShellInventory).not.toHaveBeenCalled();
  });

  it.each([
    { stdout: "﻿" + inventory() },
    { stdout: inventory().slice(0, -1) },
    { stdout: "noise" + inventory() },
    { stdoutTruncated: true },
    { code: 79 },
  ])("fails closed on incomplete or invalid agent inventory %#", async (overrides) => {
    const runSshCommand = vi.fn(async () => result());
    const error = await Effect.runPromise(
      discoverRemoteShellProfiles(
        { executionTargetId: agent },
        {
          runRemoteAgentShellInventory: async () => result(overrides),
          runSshCommand,
        },
      ).pipe(Effect.flip),
    );
    expect(error.reason).toBe("probe-failed");
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("never falls back after agent admission/authentication failure", async () => {
    const runSshCommand = vi.fn(async () => result());
    const error = await Effect.runPromise(
      discoverRemoteShellProfiles(
        { executionTargetId: agent },
        {
          runRemoteAgentShellInventory: async () => {
            throw new Error("private auth failure");
          },
          runSshCommand,
        },
      ).pipe(Effect.flip),
    );
    expect(error.reason).toBe("probe-failed");
    expect(JSON.stringify(error)).not.toContain("private");
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it.each(["timeout", "interrupt"])("aborts agent inventory on %s", async (mode) => {
    vi.useFakeTimers();
    let started!: (signal: AbortSignal) => void;
    const ready = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const operation = discoverRemoteShellProfiles(
      { executionTargetId: agent },
      {
        runRemoteAgentShellInventory: (input) => {
          started(input.signal);
          return new Promise(() => {});
        },
      },
    );
    const fiber = Effect.runFork(operation.pipe(Effect.flip));
    const signal = await ready;
    if (mode === "timeout") {
      await vi.advanceTimersByTimeAsync(10001);
      expect((await Effect.runPromise(Fiber.join(fiber))).reason).toBe("timed-out");
    } else {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
    expect(signal.aborted).toBe(true);
  });
});
