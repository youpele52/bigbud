import { TurnId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveActiveWorkStartedAt,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  isSessionActivelyRunningTurn,
  PROVIDER_OPTIONS,
} from "./session.logic";
import { makeActivity } from "./session.logic.test.helpers";

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-2"))).toBe(false);
  });
});

describe("isSessionActivelyRunningTurn", () => {
  const completedTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns true when the current turn has not completed yet", () => {
    expect(
      isSessionActivelyRunningTurn(
        {
          ...completedTurn,
          completedAt: null,
        },
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
      ),
    ).toBe(true);
  });

  it("returns false when the same turn already completed and only the session is stale", () => {
    expect(
      isSessionActivelyRunningTurn(completedTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns true when a different turn is still active", () => {
    expect(
      isSessionActivelyRunningTurn(completedTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(true);
  });

  it("returns false when the session is not running", () => {
    expect(
      isSessionActivelyRunningTurn(completedTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns true once the latest turn has completion timestamps", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(true);
  });

  it("returns false while a different turn is still active in the session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });

  it("returns true when there is no latest turn (thread is idle)", () => {
    expect(isLatestTurnSettled(null, null)).toBe(true);
    expect(
      isLatestTurnSettled(null, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("falls back to the local send timestamp when the latest turn is already settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("advertises the currently supported providers in alphabetical order", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const copilot = PROVIDER_OPTIONS.find((option) => option.value === "copilot");
    const opencode = PROVIDER_OPTIONS.find((option) => option.value === "opencode");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    const devin = PROVIDER_OPTIONS.find((option) => option.value === "devin");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "cliProxy", label: "CLIProxy (experimental)", available: true },
      { value: "codex", label: "Codex", available: true },
      { value: "copilot", label: "Copilot", available: true },
      { value: "cursor", label: "Cursor", available: true },
      { value: "devin", label: "Devin", available: true },
      { value: "kilocode", label: "KiloCode", available: true },
      { value: "opencode", label: "OpenCode", available: true },
      { value: "pi", label: "Pi", available: true },
    ]);
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(copilot).toEqual({
      value: "copilot",
      label: "Copilot",
      available: true,
    });
    expect(devin).toEqual({
      value: "devin",
      label: "Devin",
      available: true,
    });
    expect(opencode).toEqual({
      value: "opencode",
      label: "OpenCode",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: true,
    });
  });
});
