import { describe, expect, it } from "vitest";

import {
  childrenByParent,
  collectDescendants,
  listProcesses,
  parseProcessListing,
  processAlive,
  processForest,
  processTree,
} from "./dev-process-tree.ts";

describe("dev process tree", () => {
  it("parses ps pid/ppid/stat/lstart output and ignores malformed lines", () => {
    const table = parseProcessListing(
      [
        "   10     1 Ss   Wed Oct 21 22:47:00 2026",
        "   11    10 S    Wed Oct 21 22:47:01 2026",
        " garbage",
        "",
        "   12    10 Z+   Wed Oct 21 22:47:02 2026",
      ].join("\n"),
    );
    expect(table.get(11)).toEqual({ ppid: 10, started: "Wed Oct 21 22:47:01 2026", zombie: false });
    expect(table.get(12)?.zombie).toBe(true);
    const children = childrenByParent(table);
    expect(children.get(1)).toEqual([10]);
    expect(children.get(10)).toEqual([11, 12]);
  });

  it("collects every descendant once, roots first, across several roots", () => {
    const children = new Map([
      [10, [11, 12]],
      [11, [13]],
      [20, [21]],
      // A reused PID can briefly make the table cyclic; the walk must still terminate.
      [13, [10]],
    ]);
    const tree = collectDescendants(children, [10, 20]);
    expect(tree.slice(0, 1)).toEqual([10]);
    expect(tree.toSorted((a, b) => a - b)).toEqual([10, 11, 12, 13, 20, 21]);
    expect(new Set(tree).size).toBe(tree.length);
  });

  it("returns only the roots on Windows, where taskkill /T walks the tree", () => {
    expect(processForest([4, 5], "win32")).toEqual([4, 5]);
    expect(processTree(4, "win32")).toEqual([4]);
  });

  // Real OS enumeration can slow under host load; this is not a latency benchmark.
  it.skipIf(process.platform === "win32")(
    "finds the current process in its own tree",
    () => {
      expect(processTree(process.pid)).toContain(process.pid);
      expect(listProcesses().get(process.pid)?.started).toMatch(/\d/);
      expect(processAlive(process.pid)).toBe(true);
    },
    30_000,
  );
});
