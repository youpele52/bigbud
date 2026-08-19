import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeActiveTurnInspection } from "./Adapter.activeTurnInspection.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

const THREAD_ID = ThreadId.makeUnsafe("opencode-inspection-thread");
const TURN_ID = TurnId.makeUnsafe("opencode-inspection-turn");
const NEXT_TURN_ID = TurnId.makeUnsafe("opencode-inspection-next-turn");
const SESSION_ID = "opencode-inspection-session";

function response<T>(data: T) {
  return { data, error: undefined };
}

function client(input?: {
  readonly statuses?: Record<string, unknown>;
  readonly questions?: ReadonlyArray<{ sessionID: string }>;
  readonly permissions?: ReadonlyArray<{ sessionID: string }>;
  readonly get?: () => Promise<unknown>;
  readonly statusError?: unknown;
  readonly statusThrows?: unknown;
}) {
  return {
    session: {
      status: vi.fn(async () =>
        input?.statusThrows
          ? Promise.reject(input.statusThrows)
          : input?.statusError
            ? { data: undefined, error: input.statusError }
            : response(input?.statuses ?? {}),
      ),
      get: vi.fn(async () => input?.get?.() ?? response({ id: SESSION_ID })),
    },
    question: { list: vi.fn(async () => response(input?.questions ?? [])) },
    permission: { list: vi.fn(async () => response(input?.permissions ?? [])) },
  };
}

function record(
  clientValue: ReturnType<typeof client>,
  activeTurnId: TurnId | undefined = TURN_ID,
) {
  return {
    client: clientValue,
    releaseServer: () => undefined,
    opencodeSessionId: SESSION_ID,
    threadId: THREAD_ID,
    createdAt: "2026-08-18T00:00:00.000Z",
    runtimeMode: "full-access",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    pendingPermissions: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    sseAbortController: null,
    cwd: undefined,
    model: undefined,
    providerID: undefined,
    updatedAt: "2026-08-18T00:00:00.000Z",
    lastError: undefined,
    activeTurnId,
    lastUsage: undefined,
    wasRetrying: true,
    reasoningPartIds: new Set(),
    allowedTools: {},
  } as unknown as ActiveOpencodeSession;
}

function inspectionFor(recordValue: ActiveOpencodeSession) {
  return makeActiveTurnInspection({ sessions: new Map([[THREAD_ID, recordValue]]) });
}

describe("OpenCode active turn inspection", () => {
  it.each(["busy", "retry"] as const)("maps native %s status to running", async (type) => {
    const clientValue = client({
      statuses: { [SESSION_ID]: type === "retry" ? { type, attempt: 2 } : { type } },
    });
    const result = await Effect.runPromise(inspectionFor(record(clientValue))(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "running" });
    expect(clientValue.session.status).toHaveBeenCalledOnce();
    expect(clientValue.session.get).not.toHaveBeenCalled();
  });

  it("maps an explicit native idle status to completed", async () => {
    const clientValue = client({ statuses: { [SESSION_ID]: { type: "idle" } } });
    const recordValue = record(clientValue);

    const result = await Effect.runPromise(inspectionFor(recordValue)(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "completed" });
    expect(clientValue.session.get).not.toHaveBeenCalled();
    expect(recordValue.activeTurnId).toBeUndefined();
    expect(recordValue.wasRetrying).toBe(false);
  });

  it("can inspect native completion without settling local recovery state", async () => {
    const clientValue = client({ statuses: { [SESSION_ID]: { type: "idle" } } });
    const recordValue = record(clientValue);
    const inspection = makeActiveTurnInspection({
      sessions: new Map([[THREAD_ID, recordValue]]),
      settleCompleted: false,
    });

    const result = await Effect.runPromise(inspection(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "completed" });
    expect(recordValue.activeTurnId).toBe(TURN_ID);
  });

  it("does not settle an unexpected native status as completed", async () => {
    const clientValue = client({ statuses: { [SESSION_ID]: { type: "future-status" } } });
    const recordValue = record(clientValue);

    const result = await Effect.runPromise(inspectionFor(recordValue)(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "unavailable" });
    expect(clientValue.session.get).not.toHaveBeenCalled();
    expect(recordValue.activeTurnId).toBe(TURN_ID);
  });

  it.each([
    ["question", { questions: [{ sessionID: SESSION_ID }] }],
    ["permission", { permissions: [{ sessionID: SESSION_ID }] }],
  ] as const)("prioritizes a pending %s over native busy status", async (_kind, input) => {
    const clientValue = client({ statuses: { [SESSION_ID]: { type: "busy" } }, ...input });

    const result = await Effect.runPromise(inspectionFor(record(clientValue))(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "waiting-for-user" });
  });

  it("treats an absent status entry with a verified native session as inconclusive", async () => {
    const clientValue = client();
    const recordValue = record(clientValue);

    const result = await Effect.runPromise(inspectionFor(recordValue)(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({
      status: "unavailable",
      errorEvidence: { source: "opencode.session.get" },
    });
    expect(clientValue.session.get).toHaveBeenCalledWith({ sessionID: SESSION_ID });
    expect(recordValue.activeTurnId).toBe(TURN_ID);
    expect(recordValue.wasRetrying).toBe(true);
    expect(recordValue.updatedAt).toBe("2026-08-18T00:00:00.000Z");
  });

  it("maps a native session.get not-found response to missing", async () => {
    const clientValue = client({
      get: async () => ({ data: undefined, error: { _tag: "NotFoundError" } }),
    });
    const recordValue = record(clientValue);

    const result = await Effect.runPromise(inspectionFor(recordValue)(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "missing" });
    expect(recordValue.activeTurnId).toBe(TURN_ID);
  });

  it("returns a typed transient failure for native request errors", async () => {
    const clientValue = client({ statusError: { message: "server unavailable" } });

    await expect(
      Effect.runPromise(inspectionFor(record(clientValue))(THREAD_ID, TURN_ID)),
    ).rejects.toMatchObject({
      _tag: "ProviderAdapterRequestError",
      method: "activeTurnInspection",
    });
  });

  it("returns a typed transient failure for native transport errors", async () => {
    const clientValue = client({ statusThrows: new Error("connection reset") });

    await expect(
      Effect.runPromise(inspectionFor(record(clientValue))(THREAD_ID, TURN_ID)),
    ).rejects.toMatchObject({
      _tag: "ProviderAdapterRequestError",
      method: "activeTurnInspection",
    });
  });

  it.each([["different", NEXT_TURN_ID]] as const)(
    "does not inspect or settle a %s local active turn",
    async (_kind, activeTurnId) => {
      const clientValue = client({ statuses: { [SESSION_ID]: { type: "busy" } } });
      const result = await Effect.runPromise(
        inspectionFor(record(clientValue, activeTurnId))(THREAD_ID, TURN_ID),
      );

      expect(result).toMatchObject({ status: "unavailable" });
      expect(clientValue.session.status).not.toHaveBeenCalled();
    },
  );

  it("does not inspect or settle a local session with no active turn", async () => {
    const clientValue = client({ statuses: { [SESSION_ID]: { type: "busy" } } });
    const recordValue = record(clientValue);
    recordValue.activeTurnId = undefined;

    const result = await Effect.runPromise(inspectionFor(recordValue)(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "unavailable" });
    expect(clientValue.session.status).not.toHaveBeenCalled();
  });

  it("does not fabricate a result when the local session record is absent", async () => {
    const result = await Effect.runPromise(
      makeActiveTurnInspection({ sessions: new Map() })(THREAD_ID, TURN_ID),
    );

    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("does not clear a newer local active turn while verifying native completion", async () => {
    let recordValue: ActiveOpencodeSession;
    const clientValue = client({
      get: async () => {
        recordValue.activeTurnId = NEXT_TURN_ID;
        return response({ id: SESSION_ID });
      },
    });
    recordValue = record(clientValue);

    const result = await Effect.runPromise(inspectionFor(recordValue)(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "unavailable" });
    expect(recordValue.activeTurnId).toBe(NEXT_TURN_ID);
  });

  it("does not settle a replacement session record with the same local turn id", async () => {
    const clientValue = client({
      get: async () => response({ id: SESSION_ID }),
    });
    const original = record(clientValue);
    const replacement = record(clientValue);
    const sessions = new Map([[THREAD_ID, original]]);
    const inspection = makeActiveTurnInspection({ sessions });
    clientValue.session.get.mockImplementationOnce(async () => {
      sessions.set(THREAD_ID, replacement);
      return response({ id: SESSION_ID });
    });

    const result = await Effect.runPromise(inspection(THREAD_ID, TURN_ID));

    expect(result).toMatchObject({ status: "unavailable" });
    expect(original.activeTurnId).toBe(TURN_ID);
    expect(replacement.activeTurnId).toBe(TURN_ID);
  });
});
