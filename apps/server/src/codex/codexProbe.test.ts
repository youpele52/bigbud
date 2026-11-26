import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import {
  REMOTE_CODEX_SYNC_LAUNCH_REFUSED,
  startRemoteCodexAppServerProcess,
  startRemoteCodexAppServerProcessAsync,
} from "./codexAppServerManager.process.remote.ts";
import type {
  CodexOwnerSession,
  CodexSshOwner,
} from "./codexAppServerManager.process.remote.owner.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";

const target = "ssh:host=codex.invalid&user=dev&transport=direct-ssh";
const input = {
  threadId: ThreadId.makeUnsafe("thread-codex-probe"),
  sessionEpoch: 3,
  provider: "codex",
  providerRuntimeExecutionTargetId: target,
  workspaceExecutionTargetId: target,
  executionTargetId: "local",
  cwd: "/srv/project",
  binaryPath: "/opt/bin/codex",
  runtimeMode: "full-access",
} satisfies CodexAppServerStartSessionInput;
const versionOutput = { status: 0, stdout: "codex-cli 0.167.0\n", stderr: "" };

function fixture() {
  const ready = Promise.withResolvers<CodexOwnerSession>();
  const exit = Promise.withResolvers<Awaited<CodexOwnerSession["exit"]>>();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const owner = {
    probeProvider: vi.fn<CodexSshOwner["probeProvider"]>(async () => versionOutput),
    startProvider: vi.fn<CodexSshOwner["startProvider"]>(() => ({
      ready: ready.promise,
      cancel: vi.fn(async () => {}),
    })),
  } satisfies CodexSshOwner;
  return { owner, ready, exit, pipes: { stdin, stdout, stderr, exit: exit.promise } };
}

function refuseLegacyReadiness() {
  // SSH readiness is the owner's; there is no TypeScript readiness probe to watch.
  return () => undefined;
}

describe("remote Codex version probe", () => {
  it("has no synchronous probe, spawn or sync deadline left on the remote path", () => {
    const source = readFileSync(
      new URL("./codexAppServerManager.process.remote.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("spawnSync");
    expect(source).not.toContain("REMOTE_CODEX_SYNC_PROBE_TIMEOUT_MS");
    expect(source).not.toMatch(/\bassertSupportedRemoteCodexCliVersion\(/);
    expect(source).toContain("probeOwnedCodexVersion");
  });

  it("refuses the removed synchronous remote launcher without spawning", () => {
    expect(() => startRemoteCodexAppServerProcess(input)).toThrow(REMOTE_CODEX_SYNC_LAUNCH_REFUSED);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("probes and starts only through the typed owner port", async () => {
    const noLegacy = refuseLegacyReadiness();
    const { owner, ready, pipes } = fixture();
    ready.resolve(pipes);
    const started = await startRemoteCodexAppServerProcessAsync(input, undefined, { owner });
    expect(owner.probeProvider).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "codex",
        threadId: input.threadId,
        sessionEpoch: 3,
        executionTargetId: target,
        cwd: "/srv/project",
        binaryPath: input.binaryPath,
      },
      expect.any(AbortSignal),
    );
    expect(Object.isFrozen(owner.probeProvider.mock.calls[0]?.[0])).toBe(true);
    expect(owner.startProvider).toHaveBeenCalledOnce();
    expect(started.version).toBe("0.167.0");
    expect(started.stdin).toBe(pipes.stdin);
    expect(spawnMock).not.toHaveBeenCalled();
    noLegacy();
    vi.restoreAllMocks();
  });

  it("suppresses the owner spawn when cancelled during the probe", async () => {
    const noLegacy = refuseLegacyReadiness();
    const { owner } = fixture();
    const controller = new AbortController();
    const probing = Promise.withResolvers<AbortSignal>();
    owner.probeProvider.mockImplementationOnce((_runtime, signal) => {
      probing.resolve(signal);
      return new Promise(() => {});
    });
    const started = startRemoteCodexAppServerProcessAsync(input, controller.signal, { owner });
    const probeSignal = await probing.promise;
    const reason = new Error("cancel during version check");
    controller.abort(reason);
    await expect(started).rejects.toBe(reason);
    expect(probeSignal.aborted).toBe(true);
    expect(owner.startProvider).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    noLegacy();
    vi.restoreAllMocks();
  });
});
