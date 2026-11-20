import { afterEach, describe, expect, it } from "vitest";
import {
  readLastSettingsPath,
  readSettingsScroll,
  rememberSettingsPath,
  rememberSettingsScroll,
  resetSettingsLastLocation,
} from "./settingsLastLocation";

describe("settings last location", () => {
  afterEach(() => resetSettingsLastLocation());

  it("opens General until another page is visited, then returns to that page", () => {
    expect(readLastSettingsPath()).toBe("/settings/general");
    rememberSettingsPath("/settings/terminal");
    expect(readLastSettingsPath()).toBe("/settings/terminal");
  });

  it("ignores paths that are not Settings pages", () => {
    rememberSettingsPath("/settings/remote");
    rememberSettingsPath("/settings");
    rememberSettingsPath("/chat/abc");
    expect(readLastSettingsPath()).toBe("/settings/remote");
  });

  it("remembers each page's scroll offset separately", () => {
    rememberSettingsScroll("/settings/terminal", 812.6);
    rememberSettingsScroll("/settings/general", -5);
    expect(readSettingsScroll("/settings/terminal")).toBe(813);
    expect(readSettingsScroll("/settings/general")).toBe(0);
    expect(readSettingsScroll("/settings/ai")).toBe(0);
    rememberSettingsScroll("/elsewhere", 100);
    expect(readSettingsScroll("/elsewhere")).toBe(0);
  });
});
