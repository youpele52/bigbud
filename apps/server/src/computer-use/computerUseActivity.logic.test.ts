import { describe, expect, it } from "vitest";

import {
  beginComputerUseAction,
  COMPUTER_USE_ACTIVITY_LINGER_MS,
  deriveComputerUseActivity,
  emptyComputerUseActivityState,
  endComputerUseAction,
  markComputerUseStopped,
  pruneComputerUseActivity,
  type ComputerUseActivityState,
} from "./computerUseActivity.logic.ts";
import { makeThread, threadId, turnId } from "./computerUseStop.testSupport.ts";
import type { ComputerUseActivityAction } from "./Services/ComputerUseActivity.ts";

const A: ComputerUseActivityAction = {
  threadId: threadId("a"),
  turnId: turnId("a1"),
  surface: "desktop",
};
const NOW = 1_000_000;

function begin(state: ComputerUseActivityState, action = A) {
  const [admitted, next] = beginComputerUseAction(state, action, NOW);
  expect(admitted).toBe(true);
  return next;
}

const entries = (state: ComputerUseActivityState) => [...state.entries.values()];

describe("computer-use activity derivation", () => {
  it("is inactive with no recorded action", () => {
    expect(deriveComputerUseActivity([], [makeThread(A.threadId, A.turnId)], NOW)).toEqual({
      active: false,
      turns: [],
    });
  });

  it("counts an in-flight action even when its turn already ended", () => {
    const state = begin(emptyComputerUseActivityState);
    expect(deriveComputerUseActivity(entries(state), [makeThread(A.threadId, null)], NOW)).toEqual({
      active: true,
      turns: [
        {
          threadId: A.threadId,
          turnId: A.turnId,
          actionInFlight: true,
          turnRunning: false,
          usedDesktop: true,
        },
      ],
    });
  });

  it("keeps a finished action active while the session still runs its turn", () => {
    const state = endComputerUseAction(begin(emptyComputerUseActivityState), A, NOW);
    const later = NOW + COMPUTER_USE_ACTIVITY_LINGER_MS * 10;
    const snapshot = deriveComputerUseActivity(
      entries(state),
      [makeThread(A.threadId, A.turnId)],
      later,
    );
    expect(snapshot.turns).toEqual([
      {
        threadId: A.threadId,
        turnId: A.turnId,
        actionInFlight: false,
        turnRunning: true,
        usedDesktop: true,
      },
    ]);
  });

  it("lingers after the turn ended, then expires", () => {
    const state = endComputerUseAction(begin(emptyComputerUseActivityState), A, NOW);
    const ended = [makeThread(A.threadId, turnId("a2"))];
    const lingering = deriveComputerUseActivity(entries(state), ended, NOW + 1_000);
    expect(lingering.turns).toEqual([
      {
        threadId: A.threadId,
        turnId: A.turnId,
        actionInFlight: false,
        turnRunning: false,
        usedDesktop: true,
      },
    ]);
    const expired = NOW + COMPUTER_USE_ACTIVITY_LINGER_MS;
    expect(deriveComputerUseActivity(entries(state), ended, expired).active).toBe(false);
  });

  it("drops a stopped turn unless an action is still in flight", () => {
    const running = [makeThread(A.threadId, A.turnId)];
    const inFlight = markComputerUseStopped(begin(emptyComputerUseActivityState), [A]);
    expect(deriveComputerUseActivity(entries(inFlight), running, NOW).active).toBe(true);
    const idle = endComputerUseAction(inFlight, A, NOW);
    expect(deriveComputerUseActivity(entries(idle), running, NOW).active).toBe(false);
  });

  it("refuses later actions of a stopped turn but admits the thread's next turn", () => {
    const stopped = markComputerUseStopped(emptyComputerUseActivityState, [A]);
    expect(beginComputerUseAction(stopped, A, NOW)[0]).toBe(false);
    expect(beginComputerUseAction(stopped, { ...A, turnId: turnId("a2") }, NOW)[0]).toBe(true);
    const turnless = { threadId: A.threadId, turnId: null, surface: "browser" as const };
    const stoppedTurnless = markComputerUseStopped(emptyComputerUseActivityState, [turnless]);
    expect(beginComputerUseAction(stoppedTurnless, turnless, NOW)[0]).toBe(true);
  });

  it("remembers desktop use per turn and bumps the stop epoch at every Stop", () => {
    const browserFirst = begin(emptyComputerUseActivityState, { ...A, surface: "browser" });
    expect(entries(browserFirst)[0]!.usedDesktop).toBe(false);
    const thenDesktop = begin(endComputerUseAction(browserFirst, A, NOW));
    const thenBrowser = begin(endComputerUseAction(thenDesktop, A, NOW), {
      ...A,
      surface: "browser",
    });
    expect(entries(thenBrowser)[0]!.usedDesktop).toBe(true);
    const stopped = markComputerUseStopped(markComputerUseStopped(thenBrowser, [A]), []);
    expect(stopped.stopEpoch).toBe(thenBrowser.stopEpoch + 2);
  });

  it("prunes idle entries only", () => {
    const busy = { threadId: threadId("b"), turnId: turnId("b1"), surface: "browser" as const };
    const state = begin(endComputerUseAction(begin(emptyComputerUseActivityState), A, NOW), busy);
    const pruned = pruneComputerUseActivity(state, () => false);
    expect(entries(pruned).map((entry) => entry.threadId)).toEqual([busy.threadId]);
    expect(pruneComputerUseActivity(pruned, () => false)).toBe(pruned);
  });
});
