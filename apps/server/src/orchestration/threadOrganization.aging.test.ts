import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { DEFAULT_THREAD_ORGANIZATION } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { describe, expect, it } from "vitest";
import { effectiveOrganizationActivity, organizationWithAge } from "./threadOrganization.aging.ts";

const OLD = "2026-10-01T00:00:00.000Z";
const RECENT = "2026-11-05T00:00:00.000Z";
const base = { ...DEFAULT_THREAD_ORGANIZATION, revision: 1, changedAt: OLD };
const payload = {
  threadId: ThreadId.makeUnsafe("t"),
  reason: "idle" as const,
  organization: { ...base, state: "later" as const, revision: 2, changedAt: RECENT },
};

describe("source-aware organization age", () => {
  it("automatic moves/reactions never renew age and explicit moves do", () => {
    const later = organizationWithAge(
      { ...base, activityAt: OLD, ageProvenance: "known" },
      payload,
    );
    expect(later.activityAt).toBe(OLD);
    expect(later.changedAt).toBe(RECENT);
    expect(
      organizationWithAge(later, { ...payload, reason: "move", source: "automatic" }).activityAt,
    ).toBe(OLD);
    expect(
      organizationWithAge(later, { ...payload, reason: "move", source: "deliberate" }).activityAt,
    ).toBe(RECENT);
    expect(organizationWithAge(later, { ...payload, reason: "move" }).activityAt).toBe(RECENT);
  });
  it("pending history protects cleanup but live transitions resolve it conservatively like SQL", () => {
    expect(
      effectiveOrganizationActivity({
        createdAt: OLD,
        lastActivityAt: OLD,
        organization: { ...base, ageProvenance: "pending" },
      }),
    ).toBeNull();
    const resolved = organizationWithAge({ ...base, ageProvenance: "pending" }, payload);
    expect(resolved.ageProvenance).toBe("fallback");
    expect(resolved.activityAt).toBe(OLD);
    expect(organizationWithAge(DEFAULT_THREAD_ORGANIZATION, payload).ageProvenance).toBe("known");
  });
  it("completion/activity extend age independently without replay-time clocks or rollback", () => {
    const organization = organizationWithAge(
      { ...base, activityAt: RECENT, ageProvenance: "known" },
      {
        ...payload,
        source: "deliberate",
        organization: { ...payload.organization, changedAt: OLD },
      },
    );
    expect(organization.activityAt).toBe(RECENT);
    expect(
      effectiveOrganizationActivity({
        createdAt: OLD,
        lastActivityAt: OLD,
        organization,
        completedAt: "2026-11-06T00:00:00.000Z",
      }),
    ).toBe("2026-11-06T00:00:00.000Z");
  });
});
