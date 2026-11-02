import { DEFAULT_THREAD_ORGANIZATION } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { describe, expect, it } from "vitest";

import {
  currentThreadOrganization,
  organizationAfterArchive,
  organizationAfterMove,
  organizationAfterSnooze,
  organizationAfterSnoozeExpiry,
  organizationAfterUnarchive,
} from "./threadOrganization.logic.ts";

const at = "2026-10-30T10:00:00.000Z";
const snoozed = organizationAfterSnooze(DEFAULT_THREAD_ORGANIZATION, {
  snoozeId: "snooze-1",
  durationMinutes: 24 * 60,
  occurredAt: at,
});

describe("thread organization transitions", () => {
  it("treats threads from before Inyosira as Present", () => {
    expect(currentThreadOrganization({})).toEqual(DEFAULT_THREAD_ORGANIZATION);
  });

  it("moves between states and ignores repeated non-Present moves", () => {
    const done = organizationAfterMove(DEFAULT_THREAD_ORGANIZATION, "done", at);
    expect(done).toEqual({ state: "done", revision: 1, changedAt: at, snooze: null });
    expect(organizationAfterMove(done!, "done", at)).toBeNull();
    expect(organizationAfterMove(done!, "present", at)).toMatchObject({ revision: 2 });
  });

  it("refreshes Present when moved to Present again", () => {
    expect(organizationAfterMove(DEFAULT_THREAD_ORGANIZATION, "present", at)).toMatchObject({
      state: "present",
      revision: 1,
    });
  });

  it("snoozes into Later with an absolute deadline", () => {
    expect(snoozed).toEqual({
      state: "later",
      revision: 1,
      changedAt: at,
      snooze: { id: "snooze-1", until: "2026-10-31T10:00:00.000Z" },
    });
  });

  it("cancels a snooze when moved, even to Later again", () => {
    expect(organizationAfterMove(snoozed, "later", at)).toEqual({
      state: "later",
      revision: 2,
      changedAt: at,
      snooze: null,
    });
  });

  it("cancels snoozes on archive and returns to Present on unarchive", () => {
    expect(organizationAfterArchive(DEFAULT_THREAD_ORGANIZATION, at)).toBeNull();
    expect(organizationAfterArchive(snoozed, at)).toMatchObject({ state: "later", snooze: null });
    expect(organizationAfterUnarchive(snoozed, at)).toEqual({
      state: "present",
      revision: 2,
      changedAt: at,
      snooze: null,
    });
  });

  it("expires only the current snooze, once, and only after its deadline", () => {
    const due = "2026-10-31T10:00:00.000Z";
    expect(
      organizationAfterSnoozeExpiry(snoozed, { snoozeId: "snooze-1", occurredAt: due }),
    ).toEqual({ state: "needs-you", revision: 2, changedAt: due, snooze: null });
    expect(
      organizationAfterSnoozeExpiry(snoozed, {
        snoozeId: "snooze-1",
        occurredAt: "2026-10-31T09:59:59.999Z",
      }),
    ).toBe(null);
    expect(organizationAfterSnoozeExpiry(snoozed, { snoozeId: "snooze-0", occurredAt: due })).toBe(
      null,
    );
    const moved = organizationAfterMove(snoozed, "later", at)!;
    expect(organizationAfterSnoozeExpiry(moved, { snoozeId: "snooze-1", occurredAt: due })).toBe(
      null,
    );
  });
});
