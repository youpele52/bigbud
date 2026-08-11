import { ThreadId, TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeQueryMethods } from "./Adapter.session.query.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-lifecycle-contract");
const TURN_ID = TurnId.makeUnsafe("turn-lifecycle-contract");

function makeSession(activeTurnId?: TurnId): ActiveOpencodeSession {
  return {
    client: {} as never,
    releaseServer: () => undefined,
    opencodeSessionId: "opencode-lifecycle-contract",
    threadId: THREAD_ID,
    createdAt: "2026-08-11T00:00:00.000Z",
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
    updatedAt: "2026-08-11T00:00:00.000Z",
    lastError: undefined,
    activeTurnId,
    lastUsage: undefined,
    wasRetrying: false,
    reasoningPartIds: new Set(),
    allowedTools: {},
  };
}

function lifecycleContract(provider: "opencode" | "kilocode") {
  it(`${provider}: canonical listSessions keeps an incomplete stream running and becomes idle on completion`, async () => {
    const session = makeSession(TURN_ID);
    const sessions = new Map([[THREAD_ID, session]]);
    const methods = makeQueryMethods({
      provider,
      sessions,
      requireSession: () => Effect.succeed(session),
      syntheticEventFn: (() => Effect.die("unused")) as never,
      emitFn: () => Effect.void,
    });

    const active = await Effect.runPromise(methods.listSessions());
    expect(active).toMatchObject([
      { provider, threadId: THREAD_ID, status: "running", activeTurnId: TURN_ID },
    ]);

    session.activeTurnId = undefined;

    const completed = await Effect.runPromise(methods.listSessions());
    expect(completed).toMatchObject([{ provider, threadId: THREAD_ID, status: "ready" }]);
    expect(completed[0]).not.toHaveProperty("activeTurnId");
  });
}

describe("OpenCode-derived adapter lifecycle contract", () => {
  lifecycleContract("opencode");
  lifecycleContract("kilocode");
});
