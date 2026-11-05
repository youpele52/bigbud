import { EventId, ProviderItemId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import type { CodexAppServerManager } from "../../../codex/codexAppServerManager.ts";
import { readString } from "../../../codex/codexAppServerManager.protocol.ts";
import type { CodexAdapterShape } from "../../Services/Codex/Adapter.ts";
import { handleItemCompleted, handleTurnCompleted } from "./Adapter.stream.handlers.turn.ts";

/** Rehydrates final items with their original IDs; it never replays deltas or sums usage. */
export function makeCodexInspectActiveTurn(
  manager: CodexAppServerManager,
): CodexAdapterShape["inspectActiveTurn"] {
  return (threadId, turnId) =>
    Effect.promise(async () => {
      const session = manager.listSessions().find((entry) => entry.threadId === threadId);
      const { turn, ...inspection } = await manager.inspectActiveTurn(threadId, turnId);
      if (!turn || !session) return inspection;
      const reconciliationEvents = turn.items.flatMap((item) => {
        const id = readString(item, "id");
        if (!id) return [];
        return handleItemCompleted(
          {
            id: EventId.makeUnsafe(
              `codex:inspection:${session.sessionEpoch}:${turnId}:${id}:completed`,
            ),
            kind: "notification",
            provider: "codex",
            threadId,
            turnId,
            sessionEpoch: session.sessionEpoch,
            itemId: ProviderItemId.makeUnsafe(id),
            createdAt: turn.completedAt!,
            method: "item/completed",
            payload: { item },
          },
          threadId,
        );
      });
      const terminalEvent = handleTurnCompleted(
        {
          id: EventId.makeUnsafe(`codex:inspection:${session.sessionEpoch}:${turnId}:terminal`),
          kind: "notification",
          provider: "codex",
          threadId,
          turnId,
          sessionEpoch: session.sessionEpoch,
          createdAt: turn.completedAt!,
          method: "bigbud.inspectedTerminal",
          payload: { turn: { id: turnId, status: inspection.status, error: turn.error } },
        },
        threadId,
      )[0];
      if (!terminalEvent || terminalEvent.type !== "turn.completed")
        return { status: "unavailable" as const, observedAt: inspection.observedAt };
      return {
        ...inspection,
        reconciliationEvents,
        terminalEvent: {
          ...terminalEvent,
          payload: { ...terminalEvent.payload, recoveryRedelivery: true },
        },
      };
    });
}
