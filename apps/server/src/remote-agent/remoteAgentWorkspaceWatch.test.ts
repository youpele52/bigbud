import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { makeRemoteWorkspaceWatch } from "./remoteAgentWorkspaceWatch.ts";

type WatchEntry = {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly sizeBytes: number;
  readonly modifiedUnixMs?: number;
};

const entry: WatchEntry = { path: "README.md", isDirectory: false, isFile: true, sizeBytes: 10 };

function client(entries: ReadonlyArray<WatchEntry>): RemoteAgentWorkspaceClient {
  return {
    openWorkspace: async () => ({
      requestId: "open",
      workspaceHandle: "workspace",
      accepted: true,
      errorCode: "",
      errorMessage: "",
    }),
    listDirectory: async () => entries,
  } as unknown as RemoteAgentWorkspaceClient;
}

async function collectEvents(input: {
  readonly resolve: (executionTargetId: string) => Promise<RemoteAgentWorkspaceClient>;
  readonly leaseMs?: number;
}) {
  const stream = makeRemoteWorkspaceWatch(
    { resolve: input.resolve },
    {
      pollIntervalMs: 50,
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
    },
  ).watchDirectory({
    cwd: "/remote/project",
    relativePath: "docs",
    executionTargetId: "ssh:example",
  });
  return Array.from(
    await Effect.runPromise(Effect.flatMap(stream, (value) => Stream.runCollect(value))),
  );
}

describe("remote workspace watcher", () => {
  it("emits an initial generation, coalesces stable snapshots, and reports changes", async () => {
    let calls = 0;
    const events = await collectEvents({
      resolve: async () => {
        calls += 1;
        return client(
          calls >= 3 ? [{ ...entry, modifiedUnixMs: 2 }] : [{ ...entry, modifiedUnixMs: 1 }],
        );
      },
      leaseMs: 170,
    });

    expect(events).toEqual([
      {
        version: 1,
        type: "directoryChanged",
        relativePath: "docs",
        generation: 1,
      },
      {
        version: 1,
        type: "directoryChanged",
        relativePath: "docs",
        generation: 2,
      },
      {
        version: 1,
        type: "rescanRequired",
        relativePath: "docs",
        generation: 3,
        reason: "leaseExpired",
      },
    ]);
  });

  it("emits a rescan on transport loss and a fresh generation after recovery", async () => {
    let attempts = 0;
    const events = await collectEvents({
      resolve: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket closed");
        return client([entry]);
      },
      leaseMs: 170,
    });

    expect(events.slice(0, 3)).toEqual([
      {
        version: 1,
        type: "rescanRequired",
        relativePath: "docs",
        generation: 1,
        reason: "transportLost",
      },
      {
        version: 1,
        type: "rescanRequired",
        relativePath: "docs",
        generation: 2,
        reason: "agentRestarted",
      },
      {
        version: 1,
        type: "directoryChanged",
        relativePath: "docs",
        generation: 3,
      },
    ]);
  });
});
