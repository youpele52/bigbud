import { expect, it } from "vitest";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  forgetOrganizationEngagementCaller,
  organizationEngagedUntil,
  updateOrganizationEngagement,
} from "./organizationEngagement.ts";
it("multiple clients protect until their own leases expire; disconnect revokes only that caller", () => {
  const sql = {} as SqlClient.SqlClient;
  expect(updateOrganizationEngagement(sql, "lease-a", "thread", true, 100000)).toBe(true);
  updateOrganizationEngagement(sql, "lease-b", "thread", true, 120000);
  expect(organizationEngagedUntil(sql, "thread", 130000)).toBe(180000);
  forgetOrganizationEngagementCaller("lease-b");
  expect(organizationEngagedUntil(sql, "thread", 130000)).toBe(160000);
  expect(organizationEngagedUntil(sql, "thread", 160000)).toBeUndefined();
  forgetOrganizationEngagementCaller("lease-a");
});
it("rapid refreshes cannot extend protection and old or backward-time samples expire", () => {
  const sql = {} as SqlClient.SqlClient;
  updateOrganizationEngagement(sql, "lease-rate", "thread", true, 100000);
  updateOrganizationEngagement(sql, "lease-rate", "thread", true, 101000);
  expect(organizationEngagedUntil(sql, "thread", 101000)).toBe(160000);
  expect(organizationEngagedUntil(sql, "thread", 99000)).toBeUndefined();
  updateOrganizationEngagement(sql, "lease-rate", "thread", false, 102000);
  expect(organizationEngagedUntil(sql, "thread", 102000)).toBeUndefined();
  forgetOrganizationEngagementCaller("lease-rate");
});
