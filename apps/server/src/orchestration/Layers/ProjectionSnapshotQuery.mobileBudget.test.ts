import { MobileRecoveryBaselineError } from "@bigbud/contracts/server/mobile.recovery";
import { describe, expect, it } from "vitest";

import {
  MOBILE_BASELINE_TOO_LARGE_MESSAGE,
  MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH,
  withMobileTooLargeNotice,
} from "../../mobile/mobileRecordBounds.ts";
import { serializedBytes } from "../../ws/wsMobileRecovery.frames.ts";
import type { ProjectionMobileRecoveryBaseline } from "../Services/ProjectionSnapshotQuery.ts";
import {
  fitMobileBaselineBudget,
  mobileBaselineTooLargeError,
} from "./ProjectionSnapshotQuery.mobileBudget.ts";
import {
  mobileRecordKey,
  type MobileRecordBounds,
} from "./ProjectionSnapshotQuery.mobileRecordBounds.ts";

const KB = 1024;
const noBounds: MobileRecordBounds = {
  messageLengths: new Map(),
  planLengths: new Map(),
  activityLengths: new Map(),
};

interface MessageSpec {
  readonly id: string;
  readonly size: number;
  readonly streaming?: boolean;
}

const messages = (specs: ReadonlyArray<MessageSpec>) =>
  specs.map((spec) => ({
    id: spec.id,
    text: spec.id.slice(0, 1).repeat(spec.size),
    streaming: spec.streaming === true,
  }));

const series = (prefix: string, count: number, size: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}`, size }));

function baseline(input: {
  readonly selected: ReadonlyArray<MessageSpec>;
  readonly summary: ReadonlyArray<MessageSpec>;
}): ProjectionMobileRecoveryBaseline {
  return {
    snapshotSequence: 9,
    snapshot: { threads: [{ id: "summary-thread", messages: messages(input.summary) }] },
    selectedThread: {
      status: "present",
      thread: { id: "selected-thread", messages: messages(input.selected) },
    },
  } as unknown as ProjectionMobileRecoveryBaseline;
}

const measure = (value: ProjectionMobileRecoveryBaseline) =>
  serializedBytes({
    snapshot: value.snapshot,
    snapshotSequence: value.snapshotSequence,
    selectedThread: value.selectedThread,
  });

const selectedOf = (value: ProjectionMobileRecoveryBaseline | null) =>
  value?.selectedThread?.status === "present" ? value.selectedThread : null;

describe("fitMobileBaselineBudget", () => {
  const input = baseline({
    selected: series("s", 10, KB),
    summary: [...series("u", 3, 5 * KB), { id: "live", size: 5 * KB, streaming: true }],
  });

  it("returns a baseline within budget unchanged", () => {
    expect(fitMobileBaselineBudget(input, noBounds, measure(input))).toBe(input);
  });

  it("drops only as many old selected messages as needed when that is enough", () => {
    const maxBytes = measure(input) - 2.5 * KB;
    const fitted = fitMobileBaselineBudget(input, noBounds, maxBytes);
    const selected = selectedOf(fitted);

    expect(measure(fitted!)).toBeLessThanOrEqual(maxBytes);
    expect(selected?.hasOlderHistory).toBe(true);
    expect(selected?.thread.messages.map((message) => message.id)).toEqual([
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
      "s9",
      "s10",
    ]);
    expect(fitted?.snapshot).toBe(input.snapshot);
  });

  it("keeps the newest selected message, then previews summary messages", () => {
    const maxBytes = measure(input) - 15 * KB;
    const bounds: MobileRecordBounds = {
      ...noBounds,
      messageLengths: new Map([[mobileRecordKey("summary-thread", "u1"), 400 * KB]]),
    };
    const fitted = fitMobileBaselineBudget(input, bounds, maxBytes);
    const summary = fitted?.snapshot.threads[0]?.messages ?? [];

    expect(measure(fitted!)).toBeLessThanOrEqual(maxBytes);
    expect(selectedOf(fitted)?.thread.messages.map((message) => message.id)).toEqual(["s10"]);
    expect(selectedOf(fitted)?.hasOlderHistory).toBe(true);
    expect(summary.map((message) => message.text)).toEqual([
      withMobileTooLargeNotice("u".repeat(MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH), 400 * KB),
      withMobileTooLargeNotice("u".repeat(MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH), 5 * KB),
      withMobileTooLargeNotice("u".repeat(MOBILE_DEGRADED_TEXT_PREVIEW_LENGTH), 5 * KB),
      "l".repeat(5 * KB),
    ]);
  });

  it("gives up when neither step fits the budget", () => {
    expect(fitMobileBaselineBudget(input, noBounds, 8 * KB)).toBeNull();
  });

  it("carries the mobile message on the typed persistence failure", () => {
    const error = mobileBaselineTooLargeError();

    expect(error._tag).toBe("PersistenceSqlError");
    expect(error.detail).toBe(MOBILE_BASELINE_TOO_LARGE_MESSAGE);
    expect(error.cause).toBeInstanceOf(MobileRecoveryBaselineError);
    expect((error.cause as MobileRecoveryBaselineError).message).toBe(
      "Too much recent activity to load on mobile. Open it on the desktop.",
    );
  });
});
