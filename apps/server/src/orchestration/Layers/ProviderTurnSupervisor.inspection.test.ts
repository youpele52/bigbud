import type {
  OrchestrationThread,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import type { ProviderTurnLiveness } from "@bigbud/contracts/orchestration/providerTurnLiveness";
import { Effect } from "effect";
import { EventId } from "@bigbud/contracts/core/baseSchemas.ts";
import { describe, expect, it, vi } from "vitest";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { superviseProviderTurns } from "./ProviderTurnSupervisor.health.ts";
import type { InspectionTerminal } from "../../provider/Services/ProviderInspectionTerminal.ts";

function harness(fault?: "items" | "epoch" | "ownership" | "native" | "absent") {
  const order: string[] = [];
  const threadId = "canonical" as ThreadId;
  const turnId = "native-turn" as TurnId;
  let thread = {
    id: threadId,
    deletedAt: null,
    deletingAt: null,
    session: { activeTurnId: turnId, sessionEpoch: 2, status: "running" },
  } as OrchestrationThread;
  let journal: InspectionTerminal | undefined;
  const terminal: ProviderRuntimeEvent = {
    eventId: EventId.makeUnsafe("inspected-terminal"),
    type: "turn.completed",
    threadId,
    turnId,
    provider: "codex",
    sessionEpoch: 2,
    createdAt: "2026-10-30T01:00:00Z",
    payload: { state: "completed", recoveryRedelivery: true },
  };
  const engine = {
    getReadModel: () => Effect.succeed({ threads: [thread] }),
    dispatch: () =>
      Effect.sync(() => {
        order.push("canonical");
        return { sequence: 1 };
      }),
  } as unknown as OrchestrationEngineShape;
  const service = {
    listActiveTurnLiveness: () =>
      Effect.succeed([
        {
          threadId,
          turnId,
          provider: "codex",
          sessionEpoch: 2,
          lastMeaningfulProgressAt: "2026-10-30T00:00:00Z",
          inspectionStatus: "none",
          consecutiveInspectionFailures: 0,
        } as unknown as ProviderTurnLiveness,
      ]),
    recordTurnInspection: () => Effect.void,
    inspectActiveTurn: () =>
      Effect.succeed({
        status: "completed" as const,
        observedAt: "2026-10-30T01:00:00Z",
        reconciliationEvents: [] as ProviderRuntimeEvent[],
        terminalEvent: terminal,
      }),
    recordInspectionTerminal: () =>
      Effect.sync(() => {
        order.push("journal");
        journal = {
          version: 1,
          nativeThreadId: "native",
          terminal,
          items: [],
          acknowledgements: { ingestion: false, checkpoint: false, recovery: false },
        };
      }),
    listInspectionTerminals: () => Effect.sync(() => (journal ? [journal] : [])),
    publishInspectionTerminal: () =>
      Effect.sync(() => {
        order.push("normal-terminal");
      }),
    acknowledgeInspectionTerminal: vi.fn(() => Effect.void),
    confirmInspectedTurn: () =>
      Effect.sync(() => {
        order.push("confirm");
        if (fault === "ownership")
          thread = {
            ...thread,
            session: { ...thread.session!, activeTurnId: "new-turn" as TurnId },
          };
        return fault === "absent"
          ? "absent"
          : fault === "ownership" || fault === "native"
            ? "rejected"
            : "confirmed";
      }),
    claimTurnTerminal: vi.fn(() =>
      Effect.sync(() => {
        order.push("claim");
        return true;
      }),
    ),
  } as unknown as ProviderServiceShape;
  const reconcileInspection = () =>
    Effect.sync(() => {
      order.push("items");
      if (fault === "epoch")
        thread = { ...thread, session: { ...thread.session!, sessionEpoch: 3 } };
      if (fault === "items") throw new Error("output persistence failed");
      return true;
    });
  return {
    order,
    service,
    checkpoint: () => {
      if (journal)
        journal = {
          ...journal,
          acknowledgements: { ...journal.acknowledgements, checkpoint: true },
        };
    },
    supersede: () => {
      thread = {
        ...thread,
        session: { ...thread.session!, activeTurnId: "new-owner-turn" as TurnId },
      };
    },
    journal: () => journal,
    run: superviseProviderTurns({
      orchestrationEngine: engine,
      providerService: service,
      now: () => new Date("2026-10-30T01:00:00Z"),
      reconcileInspection,
    }),
  };
}

describe("authoritative completion settlement", () => {
  it("journals before final item ingestion and normal terminal publication", async () => {
    const test = harness();
    await Effect.runPromise(test.run);
    expect(test.order).toEqual(["journal", "items", "confirm", "normal-terminal"]);
    expect(test.order).not.toContain("claim");
  });

  it.each(["items", "epoch", "ownership", "native"] as const)(
    "does not settle after %s uncertainty",
    async (fault) => {
      const test = harness(fault);
      await Effect.runPromise(test.run);
      expect(test.order).not.toContain("canonical");
      expect(test.order).not.toContain("claim");
      expect(test.order).not.toContain("normal-terminal");
    },
  );

  it("replays a durable journal when the native process is absent, not when live evidence was rejected", async () => {
    const test = harness("absent");
    await Effect.runPromise(test.run);
    expect(test.order).toContain("normal-terminal");
  });

  it("never fabricates unfinished consumer acknowledgements when canonical ownership changes", async () => {
    const test = harness("native");
    await Effect.runPromise(test.run);
    test.checkpoint();
    test.supersede();
    await Effect.runPromise(test.run);
    expect(test.journal()?.acknowledgements).toEqual({
      ingestion: false,
      checkpoint: true,
      recovery: false,
    });
    expect(test.service.acknowledgeInspectionTerminal).not.toHaveBeenCalled();
    expect(test.order).not.toContain("normal-terminal");
  });
});
