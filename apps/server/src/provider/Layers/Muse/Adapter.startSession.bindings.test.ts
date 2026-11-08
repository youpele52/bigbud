import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type {
  MuseSessionBinding,
  MuseSessionBindingsShape,
} from "../../../persistence/Services/MuseSessionBindings.ts";
import { makeMuseAdapterShape, type MuseAdapterDeps } from "./Adapter.ts";
import type { MuseHostFactory, MuseTransport } from "./Client.ts";

/** Regression for the in-app "commandId payload conflict" on every send (2026-10-29). */
const threadId = ThreadId.makeUnsafe("thread-muse-binding");
const workspace = process.cwd();

function makeBindings(initial: MuseSessionBinding) {
  let row = initial;
  const transitions: Array<string> = [];
  const shape: MuseSessionBindingsShape = {
    find: () => Effect.succeed(row),
    reserve: () => Effect.succeed(row),
    transition: (current, phase) => {
      transitions.push(`${current.phase}->${phase}`);
      if (current.phase !== "reserved") return Effect.die(new Error("not reserved"));
      row = { ...current, phase, revision: current.revision + 1 };
      return Effect.succeed(row);
    },
  };
  return { shape, transitions, current: () => row };
}

function makeHost(options: { readonly startError?: unknown; readonly nativeModel: string }) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let model = options.nativeModel;
  let counter = 0;
  const transport: MuseTransport = {
    initializeResult: {
      grantedCapabilities: ["sessionMcp"],
      sessionDurability: "durable",
      museHome: "/fake-home",
    },
    mintCommandId: () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`,
    command: async (method, params) => {
      calls.push({ method, params });
      if (method === "session/start") throw options.startError;
      if (method === "session/resume") {
        return {
          session: {
            sessionId: params.sessionId,
            activeTurnId: null,
            modelId: model,
            providerId: "meta",
          },
          viewCursor: "v",
          history: { mode: "inline" },
          pendingRequests: [],
        };
      }
      if (method === "session/setModel") {
        model = (params.model as { modelId: string }).modelId;
        return { commandId: params.commandId, status: "accepted" };
      }
      return { commandId: params.commandId, status: "accepted" };
    },
    request: async (method, params) => {
      calls.push({ method, params: {} });
      if (method === "account/read") return { state: "accountLogin", credentialRequired: true };
      if (method === "session/read")
        return { session: { sessionId: params?.sessionId, activeTurnId: null, modelId: model } };
      return {};
    },
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    close: async () => undefined,
  };
  const factory: MuseHostFactory = async () => transport;
  return { calls, factory };
}

const binding = (phase: MuseSessionBinding["phase"]): MuseSessionBinding => ({
  threadId,
  nativeSessionId: "native-session-1",
  creationCommandId: "creation-cmd-1",
  workspace,
  storageIdentity: "/fake-home",
  selectionFingerprint: "{}",
  createdAt: "2026-10-29T10:17:24.101Z",
  phase,
  revision: phase === "reserved" ? 0 : 1,
});

const start = (deps: MuseAdapterDeps, resumeCursor?: unknown) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* makeMuseAdapterShape(deps);
      return yield* Effect.exit(
        adapter.startSession({
          threadId,
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
          cwd: workspace,
          runtimeMode: "auto-accept-edits",
          modelSelection: { provider: "muse", model: "muse-spark-1.3", subProviderID: "meta" },
        }),
      );
    }),
  );

const baseDeps = (host: ReturnType<typeof makeHost>, bindings: MuseSessionBindingsShape) => ({
  hostFactory: host.factory,
  getSettings: Effect.succeed({ enabled: true, binaryPath: "muse" }),
  platformQualified: true,
  bindings,
});

describe("Muse session start with a durable binding", () => {
  it("refuses an archived old cursor before launching Muse after a workspace reset", async () => {
    const host = makeHost({ nativeModel: "muse-spark-1.3" });
    const hostFactory = vi.fn(host.factory);
    const isArchived = vi.fn(() => Effect.succeed(true));
    const bindings = makeBindings(binding("bound"));
    const exit = await start(
      {
        ...baseDeps(host, { ...bindings.shape, find: () => Effect.succeed(undefined), isArchived }),
        hostFactory,
      },
      {
        version: 1,
        provider: "muse",
        nativeSessionId: "native-session-1",
        workspace,
        storageIdentity: "/fake-home",
        model: "old-model",
        subProviderID: "meta",
      },
    );
    expect(exit._tag).toBe("Failure");
    expect(isArchived).toHaveBeenCalledWith(threadId, "native-session-1");
    expect(hostFactory).not.toHaveBeenCalled();
    expect(host.calls).toEqual([]);
  });
  it("resumes a bound session by exact ID when no cursor is sent, never replaying session/start", async () => {
    const host = makeHost({ nativeModel: "muse-wonder-1.0" });
    const bindings = makeBindings(binding("bound"));
    const exit = await start(baseDeps(host, bindings.shape));
    expect(exit._tag).toBe("Success");
    expect(host.calls.some((call) => call.method === "session/start")).toBe(false);
    const resume = host.calls.find((call) => call.method === "session/resume");
    expect(resume?.params.sessionId).toBe("native-session-1");
    // The thread's selected model replaces the session's standing model.
    const setModel = host.calls.find((call) => call.method === "session/setModel");
    expect(setModel?.params.model).toEqual({ modelId: "muse-spark-1.3", providerId: "meta" });
    expect(bindings.transitions).toEqual([]);
  });

  it("binds and resumes an uncertain creation that Muse already applied", async () => {
    const conflict = Object.assign(
      new Error("command creation-cmd-1 rejected: commandId payload conflict"),
      { kind: "commandRejected" },
    );
    const host = makeHost({ startError: conflict, nativeModel: "muse-spark-1.3" });
    const bindings = makeBindings(binding("reserved"));
    const exit = await start(baseDeps(host, bindings.shape));
    expect(exit._tag).toBe("Success");
    expect(bindings.transitions).toEqual(["reserved->bound"]);
    expect(host.calls.find((call) => call.method === "session/start")?.params.sessionId).toBe(
      "native-session-1",
    );
    expect(host.calls.find((call) => call.method === "session/resume")?.params.sessionId).toBe(
      "native-session-1",
    );
    expect(host.calls.some((call) => call.method === "session/setModel")).toBe(false);
  });

  it("blocks an uncertain creation on any other start failure, creating nothing", async () => {
    const host = makeHost({ startError: new Error("pipe closed"), nativeModel: "muse-spark-1.3" });
    const bindings = makeBindings(binding("reserved"));
    const exit = await start(baseDeps(host, bindings.shape));
    expect(exit._tag).toBe("Failure");
    expect(bindings.transitions).toEqual(["reserved->blocked"]);
    expect(host.calls.some((call) => call.method === "session/resume")).toBe(false);
  });
});
