import { describe, expect, it } from "vitest";

import type { DirectoryState } from "./FilesPanel.shared";
import {
  getDirectoryPathReachability,
  getReachableDirectoryPaths,
  getVisibleDirectoryPaths,
  pruneRemovedPaths,
} from "./FilesPanel.pathState";

function state(
  paths: ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }>,
  options: { readonly loading?: boolean; readonly error?: string | null } = {},
): DirectoryState {
  return {
    entries: paths,
    loading: options.loading ?? false,
    error: options.error ?? null,
  };
}

describe("Files panel path state", () => {
  it("distinguishes reachable, absent, and not-yet-known directory paths", () => {
    const states = {
      "": state([{ path: "docs", kind: "directory" }]),
      docs: state([{ path: "docs/api", kind: "directory" }]),
    };

    expect(getDirectoryPathReachability("docs/api", states)).toBe("reachable");
    expect(getDirectoryPathReachability("workspace", states)).toBe("unreachable");
    expect(getDirectoryPathReachability("docs/api/generated", states)).toBe("unknown");
  });

  it("keeps paths unknown while their parent is loading or errored", () => {
    expect(
      getDirectoryPathReachability("docs", {
        "": state([], { loading: true }),
      }),
    ).toBe("unknown");
    expect(
      getDirectoryPathReachability("docs", {
        "": state([], { error: "Disconnected" }),
      }),
    ).toBe("unknown");
  });

  it("prunes removed paths and all descendants without touching siblings", () => {
    const current = { docs: true, "docs/api": true, src: false };
    expect(pruneRemovedPaths(current, ["docs"])).toEqual({ src: false });
    expect(pruneRemovedPaths(current, ["missing"])).toBe(current);
  });

  it("builds reachable paths in one traversal and excludes detached cached state", () => {
    const reachable = getReachableDirectoryPaths({
      "": state([{ path: "docs", kind: "directory" }]),
      docs: state([{ path: "docs/api", kind: "directory" }]),
      workspace: state([{ path: "workspace/src", kind: "directory" }]),
    });

    expect([...reachable]).toEqual(["", "docs", "docs/api"]);
  });

  it("selects the root and loaded, expanded, reachable directories", () => {
    expect(
      getVisibleDirectoryPaths(
        {
          docs: true,
          "docs/plan": true,
          scripts: false,
          missing: true,
        },
        {
          "": state([
            { path: "docs", kind: "directory" },
            { path: "scripts", kind: "directory" },
          ]),
          docs: state([{ path: "docs/plan", kind: "directory" }]),
          "docs/plan": state([]),
          scripts: state([]),
        },
      ),
    ).toEqual(["", "docs", "docs/plan"]);
  });

  it("keeps the root before it loads and excludes detached expanded state", () => {
    expect(getVisibleDirectoryPaths({}, {})).toEqual([""]);
    expect(
      getVisibleDirectoryPaths(
        { workspace: true, "workspace/src": true },
        {
          "": state([{ path: "docs", kind: "directory" }]),
          workspace: state([{ path: "workspace/src", kind: "directory" }]),
          "workspace/src": state([]),
        },
      ),
    ).toEqual([""]);
  });
});
