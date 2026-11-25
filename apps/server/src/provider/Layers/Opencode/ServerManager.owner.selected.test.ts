import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

import {
  assertLegacySshLaunchAllowed,
  activateDevSshOwner,
} from "../../../ssh/sshOwnerDevMode.fixture.ts";
import { DevSshOwnerRuntime } from "../../../ssh/sshOwnerDevRuntime.ts";
import { resolveProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { resolveWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { resolveProviderSessionExecutionTargets } from "../../providerSessionExecutionTargets.ts";
import type { ProviderExecutionContext } from "../../providerExecutionContext.ts";
import { isolatedEnvironment } from "../OpencodeV2/ServerManager.child.ts";
import { startManagedServer } from "./ServerManager.child.ts";
import { makeOpencodeServerManager } from "./ServerManager.ts";
import {
  OPENCODE_OWNER_START_TIMEOUT_MS,
  type OpencodeOwnerExit,
  type OpencodeOwnerStart,
  type OpencodeOwnerStartRequest,
  type OpencodeSshOwner,
} from "./ServerManager.owner.ts";
import {
  resolveSelectedOpencodeOwner,
  startSelectedOpencodeOwnerServer,
} from "./ServerManager.owner.selected.ts";

const targetId = "ssh:host=opencode-fixture&auth=ssh-key&transport=direct-ssh";
const threadId = ThreadId.makeUnsafe("thread-opencode-owner-selected");
const cwd = "/srv/opencode workspace";
const binaryPath = "/opt/opencode/bin/opencode";
const providerRuntimeTarget = resolveProviderRuntimeTarget({ executionTargetId: targetId });
const workspaceTarget = resolveWorkspaceTarget({ executionTargetId: targetId, cwd });
const executionContext: ProviderExecutionContext = {
  providerRuntimeTarget,
  workspaceTarget,
  executionTargets: resolveProviderSessionExecutionTargets({
    providerRuntimeExecutionTargetId: targetId,
    workspaceExecutionTargetId: targetId,
  }),
};
const localContext: ProviderExecutionContext = {
  providerRuntimeTarget: resolveProviderRuntimeTarget({ executionTargetId: "local" }),
  workspaceTarget: resolveWorkspaceTarget({ executionTargetId: "local", cwd }),
  executionTargets: resolveProviderSessionExecutionTargets({ executionTargetId: "local" }),
};

function ownerFixture(options: { readonly autoReady?: boolean; readonly port?: number } = {}) {
  const ready = Promise.withResolvers<{ localPort: number }>();
  const exit = Promise.withResolvers<OpencodeOwnerExit>();
  const cancel = vi.fn(async () => {});
  const start: OpencodeOwnerStart = {
    lease: { ownerEpoch: "epoch", targetGeneration: "ab".repeat(32), leaseId: "server-lease" },
    ready: ready.promise,
    exit: exit.promise,
    cancel,
  };
  const owner: OpencodeSshOwner = { startProvider: vi.fn(() => start) };
  if (options.autoReady !== false) ready.resolve({ localPort: options.port ?? 32_123 });
  return { owner, start, ready, exit, cancel };
}

function sessionFixture(owner: OpencodeSshOwner | undefined) {
  return {
    targetId,
    picker: {
      withOwner: vi.fn(
        async <A>(exactTarget: string, operation: (client: object) => Promise<A>): Promise<A> => {
          expect(exactTarget).toBe(targetId);
          return operation(owner ? { opencodeOwner: owner } : {});
        },
      ),
    },
  };
}

function provideOwnerSession(owner: OpencodeSshOwner | undefined) {
  return Layer.succeed(DevSshOwnerRuntime, {
    session: sessionFixture(owner),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  activateDevSshOwner();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("selected OpenCode v1 SSH owner composition", () => {
  it("reads readiness and serves SDK requests on the owner-selected loopback listener", async () => {
    const { owner, cancel } = ownerFixture({ port: 32_222 });
    const http = vi.fn(async (_request: Request, _init: RequestInit) => Response.json(["read"]));
    vi.stubGlobal("fetch", http);

    const started = await Effect.runPromise(
      startSelectedOpencodeOwnerServer({
        threadId,
        sessionEpoch: 2,
        binaryPath,
        executionContext,
      }).pipe(Effect.provide(provideOwnerSession(owner))),
    );
    expect(started).toBeDefined();

    const request = vi.mocked(owner.startProvider).mock.calls[0]?.[0] as
      | OpencodeOwnerStartRequest
      | undefined;
    expect(request).toEqual({
      provider: "opencode",
      threadId,
      sessionEpoch: 2,
      executionTargetId: targetId,
      cwd,
      binaryPath,
    });
    // No caller-supplied forwarding specification can reach the owner.
    expect(Object.keys(request!).sort()).toEqual([
      "binaryPath",
      "cwd",
      "executionTargetId",
      "provider",
      "sessionEpoch",
      "threadId",
    ]);
    expect(Object.isFrozen(request)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();

    expect(started!.handle.url).toBe("http://127.0.0.1:32222");
    expect((await started!.handle.client.tool.ids()).data).toEqual(["read"]);
    expect(new URL(http.mock.calls[0]![0].url).origin).toBe(started!.handle.url);

    // release() starts confirmed teardown; close() awaits the owner's own confirmation.
    started!.handle.release();
    await started!.close();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a selected remote session with no owner port instead of starting legacy SSH", async () => {
    const failure = await Effect.runPromise(
      startSelectedOpencodeOwnerServer({
        threadId,
        sessionEpoch: 2,
        binaryPath,
        executionContext,
      }).pipe(Effect.provide(provideOwnerSession(undefined)), Effect.flip),
    );
    expect(failure._tag).toBe("SelectedOpencodeOwnerError");
    expect(failure.message).toContain("no OpenCode v1 service bound");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns undefined for local OpenCode so the local path is unchanged", async () => {
    const { owner } = ownerFixture();
    const started = await Effect.runPromise(
      startSelectedOpencodeOwnerServer({
        threadId,
        sessionEpoch: 2,
        binaryPath,
        executionContext: localContext,
      }).pipe(Effect.provide(provideOwnerSession(owner))),
    );
    expect(started).toBeUndefined();
    expect(owner.startProvider).not.toHaveBeenCalled();
  });

  it("keeps the legacy remote child launcher fenced with the owner selected", async () => {
    await expect(
      startManagedServer({
        config: {
          provider: "opencode",
          displayName: "OpenCode",
          defaultBinary: "opencode",
          configContentEnvKey: "OPENCODE_CONFIG_CONTENT",
        },
        executionTargetId: targetId,
        binaryPath,
      }),
    ).rejects.toThrow(/selected SSH owner/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(() => assertLegacySshLaunchAllowed()).toThrow(/selected SSH owner/);
    // The retired v1 manager still refuses starts outright before any launcher.
    await expect(
      makeOpencodeServerManager({}).acquire({ executionTargetId: targetId, binaryPath }),
    ).rejects.toThrow(/read-only/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps OpenCode v2's typed SSH bootstrap refusal when no owner can provide it", async () => {
    await expect(
      isolatedEnvironment({
        runtimeTargetId: targetId,
        binaryPath,
        profileRoot: "/tmp/bigbud-opencode-v2",
      } as never),
    ).rejects.toThrow(/OpenCode v2 SSH bootstrap is not verified/);
  });

  it("rejects a listener that never becomes ready and closes the exact lease", async () => {
    vi.useFakeTimers();
    const { owner, cancel } = ownerFixture({ autoReady: false });
    const started = startSelectedOpencodeOwnerServer({
      threadId,
      sessionEpoch: 2,
      binaryPath,
      executionContext,
    }).pipe(Effect.provide(provideOwnerSession(owner)), Effect.flip);
    const settled = Effect.runPromise(started);
    await vi.advanceTimersByTimeAsync(OPENCODE_OWNER_START_TIMEOUT_MS + 1);
    const failure = await settled;
    expect(failure._tag).toBe("SelectedOpencodeOwnerError");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("selected OpenCode v1 owner resolution", () => {
  it("returns the typed port for a bound dev session", async () => {
    const { owner } = ownerFixture();
    const resolved = await resolveSelectedOpencodeOwner(sessionFixture(owner) as never);
    expect(resolved).toEqual({ targetId, owner });
  });

  it("returns undefined when the dev session exposes no OpenCode port", async () => {
    await expect(resolveSelectedOpencodeOwner(sessionFixture(undefined) as never)).resolves.toBe(
      undefined,
    );
    await expect(resolveSelectedOpencodeOwner(undefined)).resolves.toBe(undefined);
  });
});
