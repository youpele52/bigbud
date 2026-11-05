import { describe, expect, it } from "vitest";

import {
  isBroadRemoteWorkspaceRoot,
  joinRemoteFolderPath,
  parentRemoteFolderPath,
} from "./Sidebar.remoteWorkspaces.logic";

describe("remote folder paths", () => {
  it("flags the machine root and the home folder as broad project roots", () => {
    expect(isBroadRemoteWorkspaceRoot("/", null)).toBe(true);
    expect(isBroadRemoteWorkspaceRoot("~/", null)).toBe(true);
    expect(isBroadRemoteWorkspaceRoot("/home/dev/", "/home/dev")).toBe(true);
    expect(isBroadRemoteWorkspaceRoot("/home/dev/api", "/home/dev")).toBe(false);
    expect(isBroadRemoteWorkspaceRoot("/home/dev", null)).toBe(false);
  });

  it("joins and walks up POSIX folder paths", () => {
    expect(joinRemoteFolderPath("/", "srv")).toBe("/srv");
    expect(joinRemoteFolderPath("/home/dev", "api")).toBe("/home/dev/api");
    expect(parentRemoteFolderPath("/home/dev/api")).toBe("/home/dev");
    expect(parentRemoteFolderPath("/srv")).toBe("/");
    expect(parentRemoteFolderPath("/")).toBe("/");
  });
});
