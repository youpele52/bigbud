import { ThreadId, TurnId, type OrchestrationThread } from "@bigbud/contracts";
import type { ProviderTurnLiveness } from "@bigbud/contracts/orchestration/providerTurnLiveness";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  PROVIDER_TURN_SILENCE_THRESHOLD_MS,
  superviseProviderTurns,
} from "./ProviderTurnSupervisor.ts";

const now = new Date("2026-08-13T12:00:00.000Z");
const threadId = ThreadId.makeUnsafe("supervised-thread");
const turnId = TurnId.makeUnsafe("supervised-turn");

function liveness(overrides: Partial<ProviderTurnLiveness> = {}): ProviderTurnLiveness {
  return {
    threadId,
    turnId,
    provider: "codex",
    turnStartedAt: "2026-08-13T11:00:00.000Z",
    lastRuntimeEventAt: null,
    lastMeaningfulProgressAt: "2026-08-13T11:00:00.000Z",
    lastInspectionAt: null,
    inspectionStatus: "idle",
    consecutiveInspectionFailures: 0,
    terminalAt: null,
    ...overrides,
  };
}

function thread(): OrchestrationThread {
  return {
    id: threadId,
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      reason: null,
      lastError: null,
      updatedAt: "2026-08-13T11:00:00.000Z",
    },
  } as OrchestrationThread;
}

function harness(input: {
  row: ProviderTurnLiveness;
  inspection: ProviderServiceShape["inspectActiveTurn"];
}) {
  const commands: unknown[] = [];
  const recordTurnInspection = vi.fn(() => Effect.void);
  const claimTurnTerminal = vi.fn(() => Effect.succeed(true));
  const providerService = {
    listActiveTurnLiveness: () => Effect.succeed([input.row]),
    inspectActiveTurn: input.inspection,
    recordTurnInspection,
    claimTurnTerminal,
  } as unknown as ProviderServiceShape;
  const orchestrationEngine = {
    getReadModel: () => Effect.succeed({ threads: [thread()] }),
    dispatch: (command: unknown) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  } as unknown as OrchestrationEngineShape;
  return { commands, providerService, orchestrationEngine, recordTurnInspection };
}

describe("provider turn supervisor", () => {
  it("does not inspect a fresh turn in an old provider session", async () => {
    const inspect = vi.fn(() =>
      Effect.succeed({ status: "running" as const, observedAt: now.toISOString() }),
    );
    const setup = harness({
      row: liveness({
        turnStartedAt: new Date(now.getTime() - 1_000).toISOString(),
        lastMeaningfulProgressAt: new Date(now.getTime() - 1_000).toISOString(),
      }),
      inspection: inspect,
    });
    await Effect.runPromise(superviseProviderTurns({ ...setup, now: () => now }));
    expect(inspect).not.toHaveBeenCalled();
    expect(setup.commands).toEqual([]);
  });

  it("settles authoritative completion once without allowing queued-prompt flush", async () => {
    const setup = harness({
      row: liveness(),
      inspection: () =>
        Effect.succeed({
          status: "completed",
          observedAt: now.toISOString(),
          completionEvidence: { source: "provider.native-status" },
        }),
    });
    await Effect.runPromise(superviseProviderTurns({ ...setup, now: () => now }));
    expect(setup.commands.at(-1)).toMatchObject({
      type: "thread.session.set",
      suppressQueuedPromptFlush: true,
      session: { status: "ready", activeTurnId: null },
    });
  });

  it("projects stalled only after bounded unavailable inspections", async () => {
    const setup = harness({
      row: liveness({ consecutiveInspectionFailures: 2 }),
      inspection: () => Effect.succeed({ status: "unavailable", observedAt: now.toISOString() }),
    });
    await Effect.runPromise(superviseProviderTurns({ ...setup, now: () => now }));
    expect(setup.commands.at(-1)).toMatchObject({
      session: { status: "error", reason: "provider.stalled", activeTurnId: turnId },
    });
  });

  it("continued meaningful progress prevents inspection", async () => {
    const inspect = vi.fn(() => Effect.never);
    const setup = harness({
      row: liveness({
        lastMeaningfulProgressAt: new Date(
          now.getTime() - PROVIDER_TURN_SILENCE_THRESHOLD_MS + 1,
        ).toISOString(),
      }),
      inspection: inspect,
    });
    await Effect.runPromise(superviseProviderTurns({ ...setup, now: () => now }));
    expect(inspect).not.toHaveBeenCalled();
  });

  it("inspects immediately after the provider event monitor is lost", async () => {
    const inspect = vi.fn(() =>
      Effect.succeed({ status: "running" as const, observedAt: now.toISOString() }),
    );
    const setup = harness({
      row: liveness({
        inspectionStatus: "checking",
        lastMeaningfulProgressAt: now.toISOString(),
      }),
      inspection: inspect,
    });
    await Effect.runPromise(superviseProviderTurns({ ...setup, now: () => now }));
    expect(inspect).toHaveBeenCalledOnce();
  });
});
