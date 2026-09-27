import { describe, expect, it } from "vitest";

import {
  readWidgetPreferences,
  useResourceWidgetPreferences,
} from "./resourceMonitorPreferences.store";

describe("resource monitor widget preferences", () => {
  it("starts with the four default widgets and accepts an empty selection", () => {
    expect(readWidgetPreferences(undefined)).toEqual(["cpu", "memory", "disk", "network"]);
    expect(readWidgetPreferences([])).toEqual([]);
  });

  it("removes unsupported and duplicate values from stored preferences", () => {
    expect(readWidgetPreferences(["network", "network", "other", "cpu"])).toEqual([
      "network",
      "cpu",
    ]);
  });

  it("hides, restores, and reorders widgets", () => {
    useResourceWidgetPreferences.setState({ visible: ["cpu", "memory", "disk", "network"] });
    useResourceWidgetPreferences.getState().toggle("memory");
    expect(useResourceWidgetPreferences.getState().visible).toEqual(["cpu", "disk", "network"]);
    useResourceWidgetPreferences.getState().toggle("memory");
    useResourceWidgetPreferences.getState().move("memory", -1);
    expect(useResourceWidgetPreferences.getState().visible).toEqual([
      "cpu",
      "disk",
      "memory",
      "network",
    ]);
  });
});
