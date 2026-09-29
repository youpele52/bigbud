import { afterEach, describe, expect, it, vi } from "vitest";

import {
  migrateLegacyDetailPreferences,
  migrateV2DetailPreferences,
  parseDetailPreferences,
  readDetailPreferences,
  useResourceDetailPreferences,
} from "./resourceMonitorDetails.store";

afterEach(() => vi.unstubAllGlobals());

describe("system monitor detail preferences", () => {
  it("defaults absent and invalid stored data to useful details", () => {
    expect(readDetailPreferences(undefined)).toContain("processes");
    expect(readDetailPreferences("invalid")).toContain("disks");
    expect(readDetailPreferences([])).toEqual([]);
    expect(readDetailPreferences(["temperatures", "temperatures", "unknown"])).toEqual([
      "temperatures",
    ]);
    expect(parseDetailPreferences("{bad json")).toContain("processes");
    expect(parseDetailPreferences(null)).toContain("disks");
    expect(readDetailPreferences(undefined)).toContain("ipAddress");
  });

  it("keeps saved detail choices and enables new defaults when migrating preferences", () => {
    expect(migrateLegacyDetailPreferences('["disks"]')).toEqual([
      "ipAddress",
      "hostDetails",
      "disks",
    ]);
    expect(migrateLegacyDetailPreferences("[]")).toEqual(["ipAddress", "hostDetails"]);
    expect(migrateV2DetailPreferences('["disks"]')).toEqual(["hostDetails", "disks"]);
    expect(migrateV2DetailPreferences('["ipAddress", "disks"]')).toEqual([
      "hostDetails",
      "ipAddress",
      "disks",
    ]);
  });

  it("persists show and hide choices without storing monitor data", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem } });
    useResourceDetailPreferences.setState({ visible: ["processes", "disks"] });
    useResourceDetailPreferences.getState().toggle("processes");
    expect(useResourceDetailPreferences.getState().visible).toEqual(["disks"]);
    expect(setItem).toHaveBeenLastCalledWith("bigbud:resource-monitor-details:v3", '["disks"]');
    useResourceDetailPreferences.getState().toggle("processes");
    expect(useResourceDetailPreferences.getState().visible).toEqual(["disks", "processes"]);
  });
});
