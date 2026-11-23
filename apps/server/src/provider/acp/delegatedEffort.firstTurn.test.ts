import { EventId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type { SessionConfigOption } from "effect-acp/schema";
import { expect, it, vi } from "vitest";

import type { CursorSessionContext } from "../Layers/Cursor/Adapter.helpers.ts";
import { makeSendTurnEffect as cursorTurn } from "../Layers/Cursor/Adapter.sendTurn.ts";
import type { DevinSessionContext } from "../Layers/Devin/Adapter.helpers.ts";
import { makeSendTurnEffect as devinTurn } from "../Layers/Devin/Adapter.sendTurn.ts";
import { createFakeAcpSessionRuntime } from "./AcpSessionRuntime.test.helpers.ts";
import { ExactDelegatedAcpEffort } from "./acpSessionEffort.ts";

it.each(
  (["cursor", "devin"] as const).flatMap((provider) =>
    (["exact", "missing-exact", "reported-mismatch", "ordinary"] as const).map(
      (mode) => [provider, mode] as const,
    ),
  ),
)("%s configures effort before its first prompt (%s)", async (provider, mode) => {
  const threadId = ThreadId.makeUnsafe("delegated-acp-effort");
  const now = "2026-11-23T00:00:00.000Z";
  const calls: Array<unknown> = [];
  let selected = false;
  let currentEffort = "low";
  const offersExact = mode === "exact" || mode === "reported-mismatch";
  const options = (): ReadonlyArray<SessionConfigOption> => [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: selected ? "wanted" : "prior",
      options: [
        { name: "Wanted", value: "wanted" },
        { name: "Prior", value: "prior" },
      ],
    },
    {
      id: selected ? "depth" : "old-depth",
      category: "thought_level",
      name: "Depth",
      type: "select",
      currentValue: currentEffort,
      options: [
        { name: "Low", value: "low" },
        ...(offersExact ? [{ name: "Extra High", value: "xhigh" }] : []),
        { name: "Maximum", value: "max" },
      ],
    },
  ];
  const acp = {
    ...createFakeAcpSessionRuntime(),
    getConfigOptions: Effect.sync(options),
    setModel: vi.fn((model: string) =>
      Effect.sync(() => {
        selected = true;
        calls.push(["model", model]);
      }),
    ),
    setConfigOption: vi.fn((id: string, value: string | boolean) =>
      Effect.sync(() => {
        calls.push(["session/set_config_option", id, value]);
        currentEffort = mode === "reported-mismatch" ? "max" : String(value);
        return { configOptions: options() };
      }),
    ),
    prompt: vi.fn(() =>
      Effect.sync(() => {
        calls.push("session/prompt");
        return { stopReason: "end_turn" as const };
      }),
    ),
  };
  const common = {
    threadId,
    sessionEpoch: 1,
    acp,
    notificationFiber: undefined,
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    lastPlanFingerprint: undefined,
    activeTurnId: undefined,
    stopped: false,
  };
  const session = {
    status: "ready",
    runtimeMode: "full-access",
    threadId,
    sessionEpoch: 1,
    createdAt: now,
    updatedAt: now,
  } as const;
  const deps = {
    fileSystem: { readFile: () => Effect.die("unused") } as never,
    attachmentsDir: "/tmp",
    nowIso: Effect.succeed(now),
    makeEventStamp: () =>
      Effect.succeed({ eventId: EventId.makeUnsafe("fixture-event"), createdAt: now }),
    offerRuntimeEvent: () => Effect.void,
  };
  const input = { threadId, input: "First prompt" };
  const choice = { model: "wanted", options: { reasoning: "xhigh" } };
  const provideEffort = Effect.provideService(
    ExactDelegatedAcpEffort,
    mode === "ordinary" ? undefined : "xhigh",
  );
  const send = () => {
    if (provider === "cursor") {
      const ctx: CursorSessionContext = {
        ...common,
        session: { ...session, provider },
        scope: {} as CursorSessionContext["scope"],
      };
      return Effect.runPromise(
        cursorTurn(
          { ...deps, requireSession: () => Effect.succeed(ctx) },
          { ...input, modelSelection: { ...choice, provider } },
        ).pipe(provideEffort),
      );
    } else {
      const ctx: DevinSessionContext = {
        ...common,
        session: { ...session, provider },
        scope: {} as DevinSessionContext["scope"],
      };
      return Effect.runPromise(
        devinTurn(
          { ...deps, requireSession: () => Effect.succeed(ctx) },
          { ...input, modelSelection: { ...choice, provider } },
        ).pipe(provideEffort),
      );
    }
  };
  if (mode === "missing-exact" || mode === "reported-mismatch") {
    await expect(send()).rejects.toThrow(
      mode === "missing-exact" ? /exact tier is not available/ : /ACP reported "max"/,
    );
    expect(calls).toEqual([
      ["model", "wanted"],
      ...(mode === "reported-mismatch" ? [["session/set_config_option", "depth", "xhigh"]] : []),
    ]);
  } else {
    await send();
    expect(calls).toEqual([
      ["model", "wanted"],
      ["session/set_config_option", "depth", mode === "ordinary" ? "max" : "xhigh"],
      "session/prompt",
    ]);
  }
});
