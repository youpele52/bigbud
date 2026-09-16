import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_MCP_STARTUP_STATUS_UPDATED,
  CODEX_REQUIRED_MCP_READINESS_TIMEOUT_MS,
  CodexAppServerManager,
  createCodexMcpReadinessTracker,
} from "./codexAppServerManager.ts";
import {
  baseCodexSessionInput,
  createCodexSessionFixture,
  respondToBootstrapRequest,
  type CodexSessionFixture,
} from "./codexAppServerManager.startSession.mcp.fixtures.ts";

const processMocks = vi.hoisted(() => ({
  startCodexAppServerProcess: vi.fn(),
}));

vi.mock("./codexAppServerManager.process", () => processMocks);
vi.mock("./codexVersionCheck", () => ({
  assertSupportedCodexCliVersion: vi.fn(),
}));

const requiredServerName = "bigbud_remote_workspace";

function setup(input: {
  readonly statusProbeUnavailable?: boolean;
  readonly onRequest?: (request: Parameters<CodexSessionFixture["respond"]>[0]) => void;
}) {
  const fixture = createCodexSessionFixture();
  processMocks.startCodexAppServerProcess.mockReturnValue(fixture.child);
  fixture.setRequestHandler((request) => {
    const bootstrapOptions =
      input.statusProbeUnavailable === undefined
        ? undefined
        : { statusProbeUnavailable: input.statusProbeUnavailable };
    if (respondToBootstrapRequest(fixture, request, bootstrapOptions)) {
      return;
    }
    input.onRequest?.(request);
  });
  const manager = new CodexAppServerManager();
  const events: Array<{
    readonly method: string;
    readonly kind: string;
    readonly message?: string;
  }> = [];
  manager.on("event", (event) => {
    events.push({
      method: event.method,
      kind: event.kind,
      ...(event.message ? { message: event.message } : {}),
    });
  });
  return { fixture, manager, events };
}

function status(
  fixture: CodexSessionFixture,
  providerThreadId: string,
  value: "ready" | "failed" | "pending",
  extra: Record<string, unknown> = {},
): void {
  fixture.notify(CODEX_MCP_STARTUP_STATUS_UPDATED, {
    threadId: providerThreadId,
    name: requiredServerName,
    status: value,
    ...extra,
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Codex remote MCP startup readiness lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    processMocks.startCodexAppServerProcess.mockReset();
  });

  it("retains a matching ready status delivered before thread/start resolves", async () => {
    const { fixture, manager, events } = setup({
      onRequest: (request) => {
        if (request.method === "thread/start") {
          status(fixture, "provider-new", "ready");
          fixture.respond(request, { thread: { id: "provider-new" } });
        }
      },
    });

    await expect(manager.startSession(baseCodexSessionInput())).resolves.toMatchObject({
      status: "ready",
      resumeCursor: { threadId: "provider-new" },
    });
    expect(events.filter(({ method }) => method === "session/ready")).toHaveLength(1);
    manager.stopAll();
  });

  it("does not publish readiness before a post-thread ready status arrives", async () => {
    const { fixture, manager, events } = setup({
      onRequest: (request) => {
        if (request.method === "thread/start") {
          fixture.respond(request, { thread: { id: "provider-new" } });
        }
      },
    });
    const startup = manager.startSession(baseCodexSessionInput());
    await fixture.nextRequest("thread/start");
    await flush();
    expect(events.filter(({ method }) => method === "session/ready")).toHaveLength(0);

    status(fixture, "provider-new", "ready");
    await expect(startup).resolves.toMatchObject({ status: "ready" });
    manager.stopAll();
  });

  it("accepts matching readiness for a successful resume", async () => {
    const { fixture, manager } = setup({
      onRequest: (request) => {
        if (request.method === "thread/resume") {
          status(fixture, "provider-resumed", "ready");
          fixture.respond(request, { thread: { id: "provider-resumed" } });
        }
      },
    });

    await expect(
      manager.startSession(baseCodexSessionInput({ resumeCursor: { threadId: "provider-old" } })),
    ).resolves.toMatchObject({ resumeCursor: { threadId: "provider-resumed" } });
    manager.stopAll();
  });

  it("isolates recoverable resume fallback from abandoned and unrelated thread statuses", async () => {
    const { fixture, manager } = setup({
      onRequest: (request) => {
        if (request.method === "thread/resume") {
          status(fixture, "provider-abandoned", "ready");
          fixture.respondError(request, "thread/resume failed: thread not found");
        }
        if (request.method === "thread/start") {
          status(fixture, "provider-abandoned", "ready");
          status(fixture, "provider-other", "ready");
          status(fixture, "provider-child", "ready");
          fixture.respond(request, { thread: { id: "provider-fallback" } });
          status(fixture, "provider-fallback", "ready");
        }
      },
    });

    await expect(
      manager.startSession(baseCodexSessionInput({ resumeCursor: { threadId: "provider-old" } })),
    ).resolves.toMatchObject({ resumeCursor: { threadId: "provider-fallback" } });
    manager.stopAll();
  });

  it("rejects a failed required bridge even after ready and with cached tools", async () => {
    const cleanup = vi.fn(async () => undefined);
    const { fixture, manager, events } = setup({
      onRequest: (request) => {
        if (request.method === "thread/start") {
          status(fixture, "provider-failed", "ready");
          status(fixture, "provider-failed", "failed", {
            tools: [{ name: "bash" }],
            failureReason: "bridge authentication failed",
          });
          status(fixture, "provider-failed", "ready");
          fixture.respond(request, { thread: { id: "provider-failed" } });
        }
      },
    });

    await expect(
      manager.startSession(
        baseCodexSessionInput({
          cleanupRemoteWorkspaceBridge: cleanup,
          requiredMcpServerNames: ["other-required-server", requiredServerName],
        }),
      ),
    ).rejects.toThrow("Required Codex MCP server 'bigbud_remote_workspace' failed to start");
    expect(events.filter(({ method }) => method === "session/ready")).toHaveLength(0);
    expect(manager.hasSession(baseCodexSessionInput().threadId)).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("allows verified readiness after the optional status probe is unavailable", async () => {
    const { fixture, manager, events } = setup({
      statusProbeUnavailable: true,
      onRequest: (request) => {
        if (request.method === "thread/start") {
          status(fixture, "provider-new", "ready");
          fixture.respond(request, { thread: { id: "provider-new" } });
        }
      },
    });

    await expect(
      manager.startSession(
        baseCodexSessionInput({ expectedMcpServerNames: ["bigbud_orchestration"] }),
      ),
    ).resolves.toMatchObject({ status: "ready" });
    expect(events).toContainEqual(
      expect.objectContaining({ method: "session/mcpStatusUnavailable" }),
    );
    manager.stopAll();
  });

  it("keeps local-only startup permissive when the optional probe is unavailable", async () => {
    const { fixture, manager } = setup({
      statusProbeUnavailable: true,
      onRequest: (request) => {
        if (request.method === "thread/start") {
          fixture.respond(request, { thread: { id: "provider-local" } });
        }
      },
    });

    const { requiredMcpServerNames: _requiredMcpServerNames, ...localInput } =
      baseCodexSessionInput({
        expectedMcpServerNames: ["bigbud_orchestration"],
      });
    await expect(manager.startSession(localInput)).resolves.toMatchObject({ status: "ready" });
    manager.stopAll();
  });

  it("rejects pending readiness at the named deadline and cleans the bridge", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => undefined);
    const { fixture, manager, events } = setup({
      statusProbeUnavailable: true,
      onRequest: (request) => {
        if (request.method === "thread/start") {
          status(fixture, "provider-pending", "pending");
          fixture.respond(request, { thread: { id: "provider-pending" } });
        }
      },
    });

    const startup = manager.startSession(
      baseCodexSessionInput({
        cleanupRemoteWorkspaceBridge: cleanup,
        expectedMcpServerNames: ["bigbud_orchestration"],
      }),
    );
    await fixture.nextRequest("thread/start");
    const rejection = expect(startup).rejects.toThrow(
      "Timed out after 10000ms waiting for required Codex MCP server(s): bigbud_remote_workspace.",
    );
    await vi.advanceTimersByTimeAsync(CODEX_REQUIRED_MCP_READINESS_TIMEOUT_MS);
    await rejection;
    expect(events.filter(({ method }) => method === "session/ready")).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({ method: "session/mcpStatusUnavailable" }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cancels the waiter on explicit stop and ignores late readiness", async () => {
    const cleanup = vi.fn(async () => undefined);
    const { fixture, manager, events } = setup({
      onRequest: (request) => {
        if (request.method === "thread/start") {
          fixture.respond(request, { thread: { id: "provider-stopped" } });
        }
      },
    });
    const input = baseCodexSessionInput({ cleanupRemoteWorkspaceBridge: cleanup });
    const startup = manager.startSession(input);
    await fixture.nextRequest("thread/start");
    await flush();
    manager.stopSession(input.threadId);

    await expect(startup).rejects.toThrow("Codex session stopped while waiting for MCP readiness");
    status(fixture, "provider-stopped", "ready");
    await flush();
    expect(events.filter(({ method }) => method === "session/ready")).toHaveLength(0);
    expect(manager.hasSession(input.threadId)).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cancels the waiter and cleans resources when the child exits", async () => {
    const cleanup = vi.fn(async () => undefined);
    const { fixture, manager, events } = setup({
      onRequest: (request) => {
        if (request.method === "thread/start") {
          fixture.respond(request, { thread: { id: "provider-exited" } });
        }
      },
    });
    const input = baseCodexSessionInput({ cleanupRemoteWorkspaceBridge: cleanup });
    const startup = manager.startSession(input);
    await fixture.nextRequest("thread/start");
    await flush();
    fixture.child.emit("exit", 1, "SIGTERM");

    await expect(startup).rejects.toThrow("codex app-server exited");
    status(fixture, "provider-exited", "ready");
    await flush();
    expect(manager.hasSession(input.threadId)).toBe(false);
    expect(events.filter(({ method }) => method === "session/ready")).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ method: "session/exited" }));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("starts a fresh readiness context without inheriting an old context status", async () => {
    const old = createCodexMcpReadinessTracker();
    old.beginAttempt();
    old.observe({
      method: CODEX_MCP_STARTUP_STATUS_UPDATED,
      params: { threadId: "provider-old", name: requiredServerName, status: "ready" },
    });
    old.dispose();

    const fresh = createCodexMcpReadinessTracker();
    const freshAttempt = fresh.beginAttempt();
    let settled = false;
    const wait = fresh
      .waitFor(freshAttempt, "provider-old", [requiredServerName], () => true)
      .then(() => {
        settled = true;
      });
    expect(fresh.pendingWaiterCount()).toBe(1);
    old.observe({
      method: CODEX_MCP_STARTUP_STATUS_UPDATED,
      params: { threadId: "provider-old", name: requiredServerName, status: "ready" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    fresh.observe({
      method: CODEX_MCP_STARTUP_STATUS_UPDATED,
      params: { threadId: "provider-old", name: requiredServerName, status: "ready" },
    });
    await wait;
    expect(settled).toBe(true);
    expect(fresh.pendingWaiterCount()).toBe(0);
    expect(freshAttempt.id).toBe(1);
    fresh.dispose();
  });
});
