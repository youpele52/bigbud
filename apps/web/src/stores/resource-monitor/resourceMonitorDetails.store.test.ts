import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseDetailPreferences,
  readDetailPreferences,
  useResourceDetailPreferences,
} from "./resourceMonitorDetails.store";

afterEach(() => vi.unstubAllGlobals());

describe("resource monitor detail preferences", () => {
  it("defaults absent and invalid stored data to useful details", () => {
    expect(readDetailPreferences(undefined)).toContain("processes");
    expect(readDetailPreferences("invalid")).toContain("disks");
    expect(readDetailPreferences([])).toEqual([]);
    expect(readDetailPreferences(["temperatures", "temperatures", "unknown"])).toEqual([
      "temperatures",
    ]);
    expect(parseDetailPreferences("{bad json")).toContain("processes");
    expect(parseDetailPreferences(null)).toContain("disks");
  });

  it("persists show and hide choices without storing monitor data", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem } });
    useResourceDetailPreferences.setState({ visible: ["processes", "disks"] });
    useResourceDetailPreferences.getState().toggle("processes");
    expect(useResourceDetailPreferences.getState().visible).toEqual(["disks"]);
    expect(setItem).toHaveBeenLastCalledWith("bigbud:resource-monitor-details:v1", '["disks"]');
    useResourceDetailPreferences.getState().toggle("processes");
    expect(useResourceDetailPreferences.getState().visible).toEqual(["disks", "processes"]);
  });
});
