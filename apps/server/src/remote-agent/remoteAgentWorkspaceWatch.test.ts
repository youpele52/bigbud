import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import type { RemoteAgentWorkspaceWatchEvent } from "./remoteAgentProtocol.ts";
import { LocalWorkspaceWatchAgentUnavailableError } from "./localWorkspaceWatchAgent.binary.ts";
import { RemoteAgentCapabilityError } from "./remoteAgentConnectionPool.ts";
import { makeRemoteWorkspaceWatch } from "./remoteAgentWorkspaceWatch.ts";

function client(input: {
  readonly events?: ReadonlyArray<RemoteAgentWorkspaceWatchEvent>;
  readonly failure?: Error;
  readonly backend?: "native" | "poll";
  readonly synchronousEvents?: boolean;
}): RemoteAgentWorkspaceClient {
  return {
    openWorkspace: async () => ({
      requestId: "open",
      workspaceHandle: "workspace",
      accepted: true,
      errorCode: "",
      errorMessage: "",
    }),
    watchDirectory: async (watchInput: {
      readonly onEvent: (event: RemoteAgentWorkspaceWatchEvent) => void;
    }) => {
      if (input.synchronousEvents) input.events?.forEach(watchInput.onEvent);
      else setTimeout(() => input.events?.forEach(watchInput.onEvent), 0);
      return {
        started: {
          requestId: "start",
          subscriptionId: "subscription",
          accepted: true,
          generation: 7,
          backend: input.backend ?? "native",
          errorCode: "",
          errorMessage: "",
        },
        failed: input.failure
          ? Promise.resolve(input.failure)
          : new Promise<Error>(() => {
              // The focused stream test ends through its Effect finalizer.
            }),
        close: async () => {},
      };
    },
  } as unknown as RemoteAgentWorkspaceClient;
}

async function collectEvents(input: {
  readonly resolve: () => Promise<RemoteAgentWorkspaceClient>;
  readonly count: number;
}) {
  const watch = makeRemoteWorkspaceWatch(
    { resolve: input.resolve },
    { reconnectDelayMs: 50 },
  ).watchDirectory({
    cwd: "/remote/project",
    relativePath: "docs",
    executionTargetId: "ssh:example",
  });
  return Array.from(
    await Effect.runPromise(
      Effect.flatMap(watch, (stream) => Stream.runCollect(Stream.take(stream, input.count))),
    ),
  );
}

describe("remote workspace watcher", () => {
  it("forwards exact changed paths without polling in TypeScript", async () => {
    const events = await collectEvents({
      resolve: async () =>
        client({
          events: [
            {
              subscriptionId: "subscription",
              generation: 7,
              sequence: 1,
              changes: [{ path: "docs/README.md", kind: "modify" }],
              rescanRequired: false,
              rescanReason: "",
              backend: "native",
            },
          ],
        }),
      count: 1,
    });

    expect(events).toEqual([
      {
        version: 2,
        type: "directoryChanged",
        relativePath: "docs",
        changedPaths: ["docs/README.md"],
        generation: 7,
        sequence: 1,
        backend: "native",
      },
    ]);
  });

  it("exposes a managed remote Rust polling fallback without credentials", async () => {
    const events = await collectEvents({
      resolve: async () =>
        client({
          backend: "poll",
          events: [
            {
              subscriptionId: "subscription",
              generation: 7,
              sequence: 1,
              changes: [{ path: "docs/fallback.md", kind: "modify" }],
              rescanRequired: false,
              rescanReason: "",
              backend: "poll",
            },
          ],
        }),
      count: 1,
    });

    expect(events[0]).toMatchObject({
      type: "directoryChanged",
      changedPaths: ["docs/fallback.md"],
      backend: "poll",
    });
  });

  it("exposes a runtime backend change after Rust recovery", async () => {
    const events = await collectEvents({
      resolve: async () =>
        client({
          events: [
            {
              subscriptionId: "subscription",
              generation: 7,
              sequence: 1,
              changes: [{ path: "docs/native.md", kind: "modify" }],
              rescanRequired: false,
              rescanReason: "",
              backend: "native",
            },
            {
              subscriptionId: "subscription",
              generation: 8,
              sequence: 2,
              changes: [],
              rescanRequired: true,
              rescanReason: "watchInvalidated",
              backend: "poll",
            },
          ],
        }),
      count: 2,
    });

    expect(events.map((event) => event.backend)).toEqual(["native", "poll"]);
  });

  it("requires a rescan after transport recovery", async () => {
    let attempts = 0;
    const events = await collectEvents({
      resolve: async () => {
        attempts += 1;
        return client(attempts === 1 ? { failure: new Error("socket closed") } : {});
      },
      count: 2,
    });

    expect(
      events.map((event) => (event.type === "rescanRequired" ? event.reason : event.type)),
    ).toEqual(["transportLost", "agentRestarted"]);
  });

  it("requires a rescan when the agent sequence has a gap", async () => {
    const events = await collectEvents({
      resolve: async () =>
        client({
          events: [
            {
              subscriptionId: "subscription",
              generation: 7,
              sequence: 1,
              changes: [{ path: "docs/one.md", kind: "modify" }],
              rescanRequired: false,
              rescanReason: "",
              backend: "native",
            },
            {
              subscriptionId: "subscription",
              generation: 7,
              sequence: 3,
              changes: [{ path: "docs/two.md", kind: "modify" }],
              rescanRequired: false,
              rescanReason: "",
              backend: "native",
            },
          ],
        }),
      count: 2,
    });

    expect(events.map((event) => event.type)).toEqual(["directoryChanged", "rescanRequired"]);
  });

  it("preserves an event received before the older start response", async () => {
    const events = await collectEvents({
      resolve: async () =>
        client({
          backend: "native",
          synchronousEvents: true,
          events: [
            {
              subscriptionId: "subscription",
              generation: 8,
              sequence: 1,
              changes: [{ path: "docs/early.md", kind: "modify" }],
              rescanRequired: false,
              rescanReason: "",
              backend: "poll",
            },
            {
              subscriptionId: "subscription",
              generation: 8,
              sequence: 3,
              changes: [{ path: "docs/gap.md", kind: "modify" }],
              rescanRequired: false,
              rescanReason: "",
              backend: "poll",
            },
          ],
        }),
      count: 2,
    });

    expect(events.map((event) => event.type)).toEqual(["directoryChanged", "rescanRequired"]);
    expect(events.map((event) => event.backend)).toEqual(["poll", "poll"]);
  });

  it("fails once when the connected agent does not support watching", async () => {
    let attempts = 0;
    const watch = makeRemoteWorkspaceWatch({
      resolve: async () => {
        attempts += 1;
        throw new RemoteAgentCapabilityError("ssh:example", "workspace.watch");
      },
    }).watchDirectory({
      cwd: "/remote/project",
      relativePath: "docs",
      executionTargetId: "ssh:example",
    });

    await expect(
      Effect.runPromise(Effect.flatMap(watch, (stream) => Stream.runDrain(stream))),
    ).rejects.toMatchObject({ retryable: false });
    expect(attempts).toBe(1);
  });

  it("does not reconnect when the local agent protocol is incompatible", async () => {
    let attempts = 0;
    const watch = makeRemoteWorkspaceWatch({
      resolve: async () => {
        attempts += 1;
        throw new LocalWorkspaceWatchAgentUnavailableError("protocol mismatch");
      },
    }).watchDirectory({
      cwd: "/remote/project",
      relativePath: "docs",
      executionTargetId: "ssh:example",
    });

    await expect(
      Effect.runPromise(Effect.flatMap(watch, (stream) => Stream.runDrain(stream))),
    ).rejects.toMatchObject({ retryable: false });
    expect(attempts).toBe(1);
  });
});
