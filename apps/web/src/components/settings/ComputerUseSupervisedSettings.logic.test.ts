import type { ComputerUsePolicyGroup } from "@bigbud/contracts/core/settings.computerUsePolicy";
import { describe, expect, it } from "vitest";

import {
  canEditPolicy,
  createPendingTracker,
  describeAppliedState,
  editPolicyBody,
  withoutSelector,
  type SupervisedNativeState,
  type SupervisedSettingsView,
} from "./ComputerUseSupervisedSettings.logic";

const calendar = { platform: "macos", kind: "bundle_id", value: "com.apple.iCal" } as const;
const notes = {
  platform: "macos",
  kind: "bundle_id",
  value: "com.apple.Notes",
  label: "Notes",
} as const;
const desired: ComputerUsePolicyGroup = {
  format: "bigbud.computerUsePolicy.v1",
  authorityId: "authority-1",
  revision: "4",
  enabled: true,
  disallowedApps: [calendar, notes],
  defaultDeliveryMode: "foreground",
  checkInIntervalMs: 600_000,
  actionTimeoutMs: 900_000,
  diagnosticMetadataEnabled: false,
  digest: "a".repeat(64),
};
const connected = (applied: string | null, digest: string | null): SupervisedNativeState => ({
  kind: "connected",
  latched: false,
  health: "ready",
  appliedRevision: applied,
  appliedDigest: digest,
  resumeChallenge: null,
});
const ready = (native: SupervisedNativeState): SupervisedSettingsView => ({
  kind: "ready",
  desired,
  native,
});

describe("supervised settings view model", () => {
  it("claims applied only for the exact acknowledged revision and digest", () => {
    expect(describeAppliedState(ready(connected("4", "a".repeat(64))))).toEqual({
      tone: "success",
      text: "Applied (revision 4).",
    });
    for (const native of [connected("3", "a".repeat(64)), connected("4", "b".repeat(64))]) {
      expect(describeAppliedState(ready(native)).tone).toBe("info");
    }
    expect(describeAppliedState(ready(connected(null, null))).text).toBe(
      "Waiting for native acknowledgement of revision 4.",
    );
  });

  it("never presents an unconnected or failed policy as enforced", () => {
    expect(describeAppliedState({ kind: "not-connected" }).tone).toBe("warning");
    expect(describeAppliedState(ready({ kind: "unavailable" }))).toEqual({
      tone: "warning",
      text: "Saved, not enforced: native control is unavailable.",
    });
    expect(describeAppliedState({ kind: "fail-closed", reason: "digest_mismatch" })).toEqual({
      tone: "error",
      text: "Protected policy could not be used (digest_mismatch); computer use stays paused.",
    });
  });

  it("allows edits only with connected native control and no pending change", () => {
    expect(canEditPolicy(ready(connected(null, null)), false)).toBe(true);
    expect(canEditPolicy(ready(connected(null, null)), true)).toBe(false);
    expect(canEditPolicy(ready({ kind: "unavailable" }), false)).toBe(false);
    expect(canEditPolicy({ kind: "not-connected" }, false)).toBe(false);
    expect(canEditPolicy({ kind: "fail-closed", reason: "corrupt" }, false)).toBe(false);
  });

  it("builds the next body from the desired group without its digest", () => {
    const body = editPolicyBody(desired, { defaultDeliveryMode: "background" });
    expect(body).not.toHaveProperty("digest");
    expect(body).toMatchObject({ revision: "4", authorityId: "authority-1" });
    expect(body.defaultDeliveryMode).toBe("background");
    expect(body.disallowedApps).toEqual([calendar, notes]);
  });

  it("restores one app by stable identity, ignoring presentation labels", () => {
    expect(withoutSelector(desired.disallowedApps, { ...notes, label: "Other" })).toEqual([
      calendar,
    ]);
    expect(withoutSelector(desired.disallowedApps, { ...calendar, kind: "path" })).toHaveLength(2);
  });
});

describe("pending tracker", () => {
  it("stays pending until every overlapping operation settles", async () => {
    // Regression (review P3): one shared boolean was cleared by whichever
    // operation finished first.
    const seen: number[] = [];
    const track = createPendingTracker((count) => seen.push(count));
    let finishFirst!: () => void;
    let failSecond!: (error: Error) => void;
    const first = track(() => new Promise<void>((resolve) => (finishFirst = resolve)));
    const second = track(() => new Promise<void>((_resolve, reject) => (failSecond = reject)));
    finishFirst();
    await first;
    expect(seen.at(-1)).toBe(1);
    failSecond(new Error("refused"));
    await expect(second).rejects.toThrow("refused");
    expect(seen).toEqual([1, 2, 1, 0]);
  });
});
