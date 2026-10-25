import { describe, expect, it } from "vitest";

import {
  addSleepEvidence,
  findSleepEpochAt,
  initialSleepEpochState,
  latestSleepEpoch,
  SLEEP_EPOCH_HISTORY_LIMIT,
  type SleepEpochState,
  type SleepEvidence,
} from "./SystemSleepEpochs.logic.ts";

const T0 = 1_761_140_000_000;
const MINUTE = 60_000;

function addAll(evidence: ReadonlyArray<SleepEvidence>) {
  let state: SleepEpochState = initialSleepEpochState;
  const opened: boolean[] = [];
  for (const entry of evidence) {
    const result = addSleepEvidence(state, entry);
    state = result.state;
    opened.push(result.opened);
  }
  return { state, opened };
}

describe("addSleepEvidence", () => {
  it("merges the three sources for one sleep into a single epoch", () => {
    const { state, opened } = addAll([
      { source: "server-gap", startedAtMs: T0, endedAtMs: T0 + 10 * MINUTE },
      { source: "desktop-hint", startedAtMs: T0 + 10 * MINUTE, endedAtMs: T0 + 10 * MINUTE + 800 },
      { source: "supervisor-clock", startedAtMs: T0 + 2_000, endedAtMs: T0 + 10 * MINUTE + 4_000 },
    ]);
    expect(opened).toEqual([true, false, false]);
    expect(state.epochs).toHaveLength(1);
    expect(state.epochs[0]).toMatchObject({
      epochId: 1,
      startedAtMs: T0,
      endedAtMs: T0 + 10 * MINUTE + 4_000,
      sources: ["server-gap", "desktop-hint", "supervisor-clock"],
    });
  });

  it("opens a zero-length epoch for a resume whose suspend was missed, and widens it later", () => {
    const { state } = addAll([
      { source: "desktop-hint", startedAtMs: T0 + 10 * MINUTE, endedAtMs: T0 + 10 * MINUTE },
      { source: "server-gap", startedAtMs: T0, endedAtMs: T0 + 10 * MINUTE + 250 },
    ]);
    expect(state.epochs).toHaveLength(1);
    expect(state.epochs[0]!.startedAtMs).toBe(T0);
    expect(state.epochs[0]!.durationMs).toBe(10 * MINUTE + 250);
  });

  it("treats a doubled resume within a minute as the same epoch", () => {
    const resume = { source: "desktop-hint" as const, startedAtMs: T0, endedAtMs: T0 + MINUTE };
    const { state, opened } = addAll([resume, { ...resume, endedAtMs: T0 + MINUTE + 30_000 }]);
    expect(opened).toEqual([true, false]);
    expect(state.epochs[0]!.sources).toEqual(["desktop-hint"]);
  });

  it("opens separate epochs for sleeps far apart, from the gap detector alone (Linux, no hints)", () => {
    const { state, opened } = addAll([
      { source: "server-gap", startedAtMs: T0, endedAtMs: T0 + MINUTE },
      { source: "server-gap", startedAtMs: T0 + 30 * MINUTE, endedAtMs: T0 + 40 * MINUTE },
    ]);
    expect(opened).toEqual([true, true]);
    expect(state.epochs.map((epoch) => epoch.epochId)).toEqual([1, 2]);
    expect(latestSleepEpoch(state.epochs)?.epochId).toBe(2);
  });

  it("keeps only the most recent epochs", () => {
    const evidence = Array.from({ length: SLEEP_EPOCH_HISTORY_LIMIT + 5 }, (_, index) => ({
      source: "server-gap" as const,
      startedAtMs: T0 + index * 10 * MINUTE,
      endedAtMs: T0 + index * 10 * MINUTE + MINUTE,
    }));
    const { state } = addAll(evidence);
    expect(state.epochs).toHaveLength(SLEEP_EPOCH_HISTORY_LIMIT);
    expect(state.epochs[0]!.epochId).toBe(6);
  });
});

describe("findSleepEpochAt", () => {
  const { state } = addAll([
    { source: "desktop-hint", startedAtMs: T0, endedAtMs: T0 + 10 * MINUTE },
  ]);

  it("covers 5 s before the start through 60 s after wake", () => {
    expect(findSleepEpochAt(state.epochs, T0 - 5_000)).toBeDefined();
    expect(findSleepEpochAt(state.epochs, T0 + 10 * MINUTE + 60_000)).toBeDefined();
  });

  it("excludes failures outside the window", () => {
    expect(findSleepEpochAt(state.epochs, T0 - 5_001)).toBeUndefined();
    expect(findSleepEpochAt(state.epochs, T0 + 10 * MINUTE + 60_001)).toBeUndefined();
  });
});
