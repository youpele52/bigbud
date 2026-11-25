import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENCODE_OWNER_CANCEL_TIMEOUT_MS,
  OPENCODE_OWNER_START_TIMEOUT_MS,
  startOwnedOpencodeServer,
  type OpencodeOwnerExit,
  type OpencodeOwnerStart,
  type OpencodeOwnerStartRequest,
  type OwnedOpencodeServerInput,
} from "./ServerManager.owner.ts";

const target = {
  executionTargetId: "ssh:host=fixture&transport=direct-ssh",
  location: "remote",
} as const;
const input = {
  providerRuntimeTarget: target,
  workspaceTarget: { ...target, cwd: "/work/with spaces" },
  threadId: "thread-1" as ThreadId,
  sessionEpoch: 3,
  binaryPath: "/opt/configured opencode",
} satisfies Omit<OwnedOpencodeServerInput, "owner">;

function fixture() {
  const ready = Promise.withResolvers<{ localPort: number }>();
  const exit = Promise.withResolvers<OpencodeOwnerExit>();
  const cancel = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const start: OpencodeOwnerStart = {
    lease: { ownerEpoch: "epoch", targetGeneration: "ab".repeat(32), leaseId: "server-lease" },
    ready: ready.promise,
    exit: exit.promise,
    cancel,
  };
  const owner = { startProvider: vi.fn((_request: OpencodeOwnerStartRequest) => start) };
  return { owner, start, ready, exit, cancel };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OpenCode v1 SSH owner bootstrap", () => {
  it("passes only the resolved grant operands and uses the owner-selected listener for SDK requests", async () => {
    const { owner, ready, start, cancel } = fixture();
    const http = vi.fn(async (_request: Request, _init: RequestInit) => Response.json(["read"]));
    vi.stubGlobal("fetch", http);
    const acquisition = startOwnedOpencodeServer({ ...input, owner });
    expect(owner.startProvider).toHaveBeenCalledExactlyOnceWith({
      provider: "opencode",
      threadId: input.threadId,
      sessionEpoch: input.sessionEpoch,
      executionTargetId: target.executionTargetId,
      cwd: input.workspaceTarget.cwd,
      binaryPath: input.binaryPath,
    });
    expect(Object.isFrozen(owner.startProvider.mock.calls[0]?.[0])).toBe(true);
    expect(http).not.toHaveBeenCalled();
    ready.resolve({ localPort: 32123 });
    const server = await acquisition;
    expect(server.lease).toEqual(start.lease);
    expect(server.url).toBe("http://127.0.0.1:32123");
    expect((await server.client.tool.ids()).data).toEqual(["read"]);
    const [request, init] = http.mock.calls[0]!;
    expect(new URL(request.url).origin).toBe(server.url);
    expect(new URL(request.url).searchParams.get("directory")).toBe(input.workspaceTarget.cwd);
    await server.client.tool.ids(undefined, { baseUrl: "http://127.0.0.1:32000" });
    expect(http).toHaveBeenCalledOnce();
    expect(init.redirect).toBe("error");
    const closed = server.close();
    expect(server.close()).toBe(closed);
    await closed;
    expect(cancel).toHaveBeenCalledOnce();
    expect(init.signal?.aborted).toBe(true);
    await server.client.tool.ids();
    expect(http).toHaveBeenCalledOnce();
  });

  it("refuses a missing selected owner, invalid bounds, agent, local, and mismatched targets", async () => {
    const { owner } = fixture();
    await expect(startOwnedOpencodeServer({ ...input, owner: undefined })).rejects.toThrow(
      "unavailable",
    );
    for (const overrides of [
      { binaryPath: "--hostname=0.0.0.0" },
      { binaryPath: `opencode\0other` },
      { binaryPath: "π".repeat(2_049) },
      { workspaceTarget: { ...input.workspaceTarget, cwd: "relative" } },
      { providerRuntimeTarget: { executionTargetId: "local", location: "local" } },
      { workspaceTarget: { ...input.workspaceTarget, executionTargetId: "ssh:other" } },
      {
        providerRuntimeTarget: { ...target, executionTargetId: "ssh:host=fixture&transport=agent" },
        workspaceTarget: {
          ...input.workspaceTarget,
          executionTargetId: "ssh:host=fixture&transport=agent",
        },
      },
      { sessionEpoch: -1 },
    ] satisfies Partial<OwnedOpencodeServerInput>[]) {
      await expect(startOwnedOpencodeServer({ ...input, owner, ...overrides })).rejects.toThrow();
    }
    expect(owner.startProvider).not.toHaveBeenCalled();
  });

  it("does not retry a denied reservation or dispatch a pre-aborted start", async () => {
    const { owner } = fixture();
    const denied = new Error("grant no longer current");
    owner.startProvider.mockImplementationOnce(() => {
      throw denied;
    });
    await expect(startOwnedOpencodeServer({ ...input, owner })).rejects.toBe(denied);
    await expect(
      startOwnedOpencodeServer({ ...input, owner, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(owner.startProvider).toHaveBeenCalledOnce();
  });

  it.each([0, 65_536, 1.5, Number.NaN])(
    "rejects listener port %s and closes the exact lease",
    async (localPort) => {
      const { owner, ready, cancel } = fixture();
      ready.resolve({ localPort });
      await expect(startOwnedOpencodeServer({ ...input, owner })).rejects.toThrow("listener port");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("cancels a timed-out start and never accepts the late listener", async () => {
    vi.useFakeTimers();
    const { owner, ready, cancel, exit } = fixture();
    const result = expect(startOwnedOpencodeServer({ ...input, owner })).rejects.toThrow(
      "readiness timed out",
    );
    await vi.advanceTimersByTimeAsync(OPENCODE_OWNER_START_TIMEOUT_MS);
    await result;
    ready.resolve({ localPort: 32001 });
    exit.reject(new Error("owner disconnected"));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts startup without closing a sibling reservation and waits for teardown confirmation", async () => {
    const first = fixture();
    const second = fixture();
    const teardown = Promise.withResolvers<void>();
    first.cancel.mockReturnValue(teardown.promise);
    const controller = new AbortController();
    const acquisition = startOwnedOpencodeServer({
      ...input,
      owner: first.owner,
      signal: controller.signal,
    });
    const result = expect(acquisition).rejects.toThrow("cancelled");
    controller.abort();
    second.ready.resolve({ localPort: 32002 });
    const sibling = await startOwnedOpencodeServer({
      ...input,
      owner: second.owner,
      sessionEpoch: 4,
    });
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).not.toHaveBeenCalled();
    first.ready.resolve({ localPort: 32001 });
    teardown.resolve();
    await result;
    expect(sibling.isRunning?.()).toBe(true);
    await sibling.close();
  });

  it("does not mistake loss during startup plus an unconfirmed cancel for clean teardown", async () => {
    vi.useFakeTimers();
    const { owner, exit, cancel } = fixture();
    cancel.mockReturnValue(new Promise(() => undefined));
    const result = expect(startOwnedOpencodeServer({ ...input, owner })).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "owner disconnected" }),
        expect.objectContaining({
          message: expect.stringContaining("teardown confirmation timed out"),
        }),
      ],
    });
    exit.reject(new Error("owner disconnected"));
    await vi.advanceTimersByTimeAsync(OPENCODE_OWNER_CANCEL_TIMEOUT_MS);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["exit", "loss"] as const)("invalidates the client on unexpected %s", async (kind) => {
    const { owner, ready, exit, cancel } = fixture();
    const controller = new AbortController();
    const status = { kind: "signaled", signal: "SIGTERM" } as const;
    const failure = new Error("owner disconnected");
    ready.resolve({ localPort: 32001 });
    const server = await startOwnedOpencodeServer({ ...input, owner, signal: controller.signal });
    const onDeath = vi.fn();
    server.onUnexpectedDeath?.(onDeath);
    controller.abort();
    expect(server.isRunning?.()).toBe(true);
    if (kind === "exit") {
      exit.resolve(status);
      await expect(server.exit).resolves.toBe(status);
    } else {
      exit.reject(failure);
      await expect(server.exit).rejects.toBe(failure);
    }
    expect(onDeath).toHaveBeenCalledOnce();
    expect(server.isRunning?.()).toBe(false);
    const lateListener = vi.fn();
    server.onUnexpectedDeath?.(lateListener);
    expect(lateListener).toHaveBeenCalledOnce();
    await server.close();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
