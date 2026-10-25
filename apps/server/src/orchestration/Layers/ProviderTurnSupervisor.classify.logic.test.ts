import {
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import {
  classifyTurnFailure,
  findToolsInFlight,
  hasProviderSleepLabel,
  intentTurnWasRunning,
  summarizeToolsInFlight,
  type TurnFailureObservation,
} from "./ProviderTurnSupervisor.classify.logic.ts";

const threadId = ThreadId.makeUnsafe("t");
const turnId = TurnId.makeUnsafe("turn");

function activity(
  kind: string,
  summary: string,
  itemId?: string,
  turn: TurnId | null = turnId,
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(`${kind}-${summary}-${itemId ?? "none"}`),
    tone: "tool",
    kind,
    summary,
    payload: { itemType: "command_execution", ...(itemId ? { itemId } : {}) },
    turnId: turn,
    createdAt: "2026-10-22T10:00:00.000Z",
  };
}

const intent: ThreadRecoveryIntent = {
  threadId,
  messageId: MessageId.makeUnsafe("m"),
  provider: "claudeAgent",
  turnId,
  disposition: "active",
  recoveryStatus: "none",
  detail: {},
  attemptCount: 0,
  lastAttemptAt: null,
  continuationMessageId: null,
  revision: 0,
  createdAt: "2026-10-22T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:00.000Z",
};

const failure = (detail: string | null, turn: TurnId | null = turnId): TurnFailureObservation => ({
  threadId,
  turnId: turn,
  kind: "runtime-error",
  observedAtMs: 0,
  detail,
});

describe("findToolsInFlight", () => {
  it("pairs started and completed tools by item ID", () => {
    const tools = findToolsInFlight(
      [
        activity("tool.started", "Run tests started", "a"),
        activity("tool.started", "Edit file started", "b"),
        activity("tool.completed", "Run tests", "a"),
      ],
      turnId,
    );
    expect(tools).toEqual(["Edit file"]);
  });

  it("counts an unmatched start without an item ID as in flight", () => {
    expect(findToolsInFlight([activity("tool.started", "Bash started")], turnId)).toEqual(["Bash"]);
    expect(
      findToolsInFlight(
        [activity("tool.started", "Bash started"), activity("tool.completed", "Bash")],
        turnId,
      ),
    ).toEqual([]);
  });

  it("ignores other turns", () => {
    expect(
      findToolsInFlight(
        [activity("tool.started", "Old started", "x", TurnId.makeUnsafe("older"))],
        turnId,
      ),
    ).toEqual([]);
  });

  it("summarizes several tools", () => {
    expect(summarizeToolsInFlight(["Bash", "Edit", "Grep"])).toBe("Bash and 2 more");
    expect(summarizeToolsInFlight([])).toBeNull();
  });
});

describe("classifyTurnFailure", () => {
  it("classifies a failure inside a sleep window", () => {
    expect(
      classifyTurnFailure({ intent, observation: failure("socket hang up"), inSleepWindow: true }),
    ).toBe("interrupted-by-sleep");
  });

  it("classifies the provider's own sleep label outside any window", () => {
    expect(hasProviderSleepLabel("Connection lost while your computer was asleep")).toBe(true);
    expect(
      classifyTurnFailure({
        intent,
        observation: failure("Connection lost while your computer was asleep"),
        inSleepWindow: false,
      }),
    ).toBe("interrupted-by-sleep");
  });

  it("does not mistake other uses of 'suspended' or 'sleep' for the machine sleeping", () => {
    for (const detail of [
      "Request failed while your account is suspended",
      "Subscription suspended while billing is updated",
      "Rate limited while sleeping between retries",
      "Tool call failed: sleep 30 exited with code 1",
    ]) {
      expect(hasProviderSleepLabel(detail)).toBe(false);
      expect(
        classifyTurnFailure({ intent, observation: failure(detail), inSleepWindow: false }),
      ).toBe("ordinary");
    }
    expect(hasProviderSleepLabel("The system went to sleep during the request")).toBe(true);
  });

  it("keeps today's behavior outside a window, for other turns and for stopped intents", () => {
    expect(
      classifyTurnFailure({ intent, observation: failure("rate limited"), inSleepWindow: false }),
    ).toBe("ordinary");
    expect(
      classifyTurnFailure({
        intent,
        observation: failure("x", TurnId.makeUnsafe("other")),
        inSleepWindow: true,
      }),
    ).toBe("ordinary");
    expect(
      classifyTurnFailure({
        intent: { ...intent, disposition: "revoked" },
        observation: failure("x"),
        inSleepWindow: true,
      }),
    ).toBe("ordinary");
  });
});

describe("intentTurnWasRunning", () => {
  const nothing = {
    runningActiveTurnId: null,
    pendingStartMessageId: null,
    trackedRunning: null,
    livenessActive: false,
  };

  it("counts a failure that names the turn, or one while the turn still runs", () => {
    expect(intentTurnWasRunning(intent, failure("x"), nothing)).toBe(true);
    const unnamed = failure("x", null);
    expect(intentTurnWasRunning(intent, unnamed, nothing)).toBe(false);
    expect(intentTurnWasRunning(intent, unnamed, { ...nothing, runningActiveTurnId: turnId })).toBe(
      true,
    );
    expect(intentTurnWasRunning(intent, unnamed, { ...nothing, livenessActive: true })).toBe(true);
    // The coordinator saw the turn end: liveness that lags behind does not revive it.
    expect(
      intentTurnWasRunning(intent, unnamed, {
        ...nothing,
        trackedRunning: false,
        livenessActive: true,
      }),
    ).toBe(false);
  });

  it("counts an unbound intent only while its own turn start is pending", () => {
    const unbound = { ...intent, turnId: null };
    expect(intentTurnWasRunning(unbound, failure("x", null), nothing)).toBe(false);
    expect(
      intentTurnWasRunning(unbound, failure("x", null), {
        ...nothing,
        pendingStartMessageId: unbound.messageId,
      }),
    ).toBe(true);
  });
});
