import { expect, it } from "vitest";
import { buildOrganizationFacts } from "./organizationFacts.build.ts";
import type { RawOrganizationFacts } from "./organizationFacts.query.ts";

const raw: RawOrganizationFacts = {
  threadId: "thread",
  organizationRevision: 1,
  section: "needs-you",
  activityAt: "2026-11-01T00:00:00.000Z",
  workCompletedAt: "",
  agePending: 0,
  inScope: 1,
  work: 1,
  actionable: 0,
  attentionIdsJson: "[]",
  snoozeIdentity: null,
  snoozeUntil: null,
  factVersion: 1,
  semanticDigest: null,
  lastWorkState: "idle",
  lastWorkCompletedAtMs: null,
  manualUntilMs: null,
  manualAttentionWatermark: 0,
  attentionWatermark: 0,
  graceUntilMs: null,
  attentionHistoryJson: "[]",
  deleted: 0,
  needsAttentionReminder: 0,
  latestAutomaticMoveId: "automatic-op",
};
const owners = { terminal: { state: "idle" as const, quietSince: null }, shell: "idle" as const };
const build = (changes: Partial<RawOrganizationFacts>) =>
  buildOrganizationFacts({ ...raw, ...changes }, owners, Date.now(), 300000);

it("marks only automation's own Needs you placement and republishes when it clears", () => {
  const automatic = build({});
  expect(automatic.row.automaticPlacement).toBe(true);
  const manual = build({ latestAutomaticMoveId: null });
  expect(manual.row.automaticPlacement).toBe(false);
  expect(manual.digest).not.toBe(automatic.digest);
  expect(build({ section: "present" }).row.automaticPlacement).toBe(false);
});

it("protects a half-cleared snooze pair as an open-ended snooze instead of a malformed row", () => {
  const missingDeadline = build({ snoozeIdentity: "snooze-1" }).row;
  expect(missingDeadline).toMatchObject({
    snoozeIdentity: "snooze-1",
    snoozeUntilMs: Number.MAX_SAFE_INTEGER,
  });
  const missingIdentity = build({ snoozeUntil: "2026-11-02T00:00:00.000Z" }).row;
  expect(missingIdentity.snoozeIdentity).not.toBe("");
  expect(missingIdentity.snoozeUntilMs).toBe(Number.MAX_SAFE_INTEGER);
  const consistent = build({ snoozeIdentity: "s", snoozeUntil: "2026-11-02T00:00:00.000Z" }).row;
  expect(consistent.snoozeUntilMs).toBe(Date.parse("2026-11-02T00:00:00.000Z"));
});
