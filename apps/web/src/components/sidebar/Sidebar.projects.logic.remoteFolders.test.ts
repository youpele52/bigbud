import { describe, expect, it } from "vitest";

import {
  isBroadRemoteProjectRoot,
  joinRemoteFolderPath,
  parentRemoteFolderPath,
} from "./Sidebar.projects.logic";

describe("remote folder paths", () => {
  it("flags the machine root and the home folder as broad project roots", () => {
    expect(isBroadRemoteProjectRoot("/", null)).toBe(true);
    expect(isBroadRemoteProjectRoot("~/", null)).toBe(true);
    expect(isBroadRemoteProjectRoot("/home/dev/", "/home/dev")).toBe(true);
    expect(isBroadRemoteProjectRoot("/home/dev/api", "/home/dev")).toBe(false);
    expect(isBroadRemoteProjectRoot("/home/dev", null)).toBe(false);
  });

  it("joins and walks up POSIX folder paths", () => {
    expect(joinRemoteFolderPath("/", "srv")).toBe("/srv");
    expect(joinRemoteFolderPath("/home/dev", "api")).toBe("/home/dev/api");
    expect(parentRemoteFolderPath("/home/dev/api")).toBe("/home/dev");
    expect(parentRemoteFolderPath("/srv")).toBe("/");
    expect(parentRemoteFolderPath("/")).toBe("/");
  });
});
