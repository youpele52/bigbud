import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeLocalWorkspaceWatch } from "./localWorkspaceWatch.ts";
import type { LocalWorkspaceWatchAgent } from "./localWorkspaceWatchAgent.ts";
import type { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

function client(failure?: Error): RemoteAgentWorkspaceClient {
  return {
    openWorkspace: async () => ({
      requestId: "open",
      workspaceHandle: "workspace",
      accepted: true,
      errorCode: "",
      errorMessage: "",
    }),
    watchDirectory: async () => ({
      started: {
        requestId: "start",
        subscriptionId: "subscription",
        accepted: true,
        generation: 7,
        backend: "native",
        errorCode: "",
        errorMessage: "",
      },
      failed: failure
        ? Promise.resolve(failure)
        : new Promise<Error>(() => {
            // The focused stream test ends through its Effect finalizer.
          }),
      close: async () => {},
    }),
  } as unknown as RemoteAgentWorkspaceClient;
}

describe("local workspace watcher", () => {
  it("resubscribes through the shared agent and mandates a rescan after recovery", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bigbud-local-watch-"));
    let attempts = 0;
    const agent = {
      getWorkspaceClient: async () => {
        attempts += 1;
        return client(attempts === 1 ? new Error("agent exited") : undefined);
      },
    } as LocalWorkspaceWatchAgent;
    const watch = makeLocalWorkspaceWatch(agent, { reconnectDelayMs: 50 }).watchDirectory({
      cwd,
      relativePath: "",
      executionTargetId: "local",
    });

    try {
      const events = Array.from(
        await Effect.runPromise(
          Effect.flatMap(watch, (stream) => Stream.runCollect(Stream.take(stream, 2))),
        ),
      );
      expect(
        events.map((event) => (event.type === "rescanRequired" ? event.reason : event.type)),
      ).toEqual(["transportLost", "agentRestarted"]);
      expect(attempts).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects remote execution targets", async () => {
    const agent = { getWorkspaceClient: async () => client() } as LocalWorkspaceWatchAgent;
    const watch = makeLocalWorkspaceWatch(agent).watchDirectory({
      cwd: "/remote",
      relativePath: "",
      executionTargetId: "ssh:example",
    });
    await expect(Effect.runPromise(watch)).rejects.toMatchObject({
      detail: expect.stringContaining("requires a local execution target"),
    });
  });
});
