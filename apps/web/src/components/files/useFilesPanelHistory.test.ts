import { describe, expect, it } from "vitest";

import {
  filesPanelAppCommandDirection,
  filesPanelNavigationDirection,
  isConfirmedMissingFileError,
} from "./useFilesPanelHistory";

describe("isConfirmedMissingFileError", () => {
  it("recognizes confirmed missing-path failures", () => {
    expect(isConfirmedMissingFileError(new Error("ENOENT: no such file or directory"))).toBe(true);
    expect(isConfirmedMissingFileError(new Error("ENOTDIR: not a directory"))).toBe(true);
  });

  it("does not classify transient preview failures as missing files", () => {
    expect(isConfirmedMissingFileError(new Error("WebSocket disconnected"))).toBe(false);
    expect(isConfirmedMissingFileError(new Error("Failed to decode image"))).toBe(false);
  });
});

describe("filesPanelNavigationDirection", () => {
  it("maps mouse back and forward buttons to Files history directions", () => {
    expect(filesPanelNavigationDirection(3)).toBe(-1);
    expect(filesPanelNavigationDirection(4)).toBe(1);
  });

  it("ignores primary, middle, and other mouse buttons", () => {
    expect(filesPanelNavigationDirection(0)).toBeNull();
    expect(filesPanelNavigationDirection(1)).toBeNull();
    expect(filesPanelNavigationDirection(2)).toBeNull();
  });
});

describe("filesPanelAppCommandDirection", () => {
  it("maps native browser commands to Files history directions", () => {
    expect(filesPanelAppCommandDirection("browser-backward")).toBe(-1);
    expect(filesPanelAppCommandDirection("browser-forward")).toBe(1);
  });

  it("ignores unrelated desktop actions", () => {
    expect(filesPanelAppCommandDirection("open-settings")).toBeNull();
  });
});
