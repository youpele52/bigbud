import type { SystemSearchTierUpdate } from "@bigbud/contracts/search/systemSearch.ts";
import { describe, expect, it } from "vitest";

import { SystemSearchEmitter } from "./SystemSearch.emitter.ts";

function rows(count: number, prefix = "r") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    kind: "name" as const,
    executionTargetId: "local",
    root: "/r",
    path: `${prefix}${index}`,
  }));
}

describe("SystemSearchEmitter", () => {
  it("deduplicates rows and caps the query at the row limit", () => {
    const updates: SystemSearchTierUpdate[] = [];
    const emitter = new SystemSearchEmitter(
      "q",
      new AbortController().signal,
      (u) => updates.push(u),
      5,
    );
    expect(emitter.rowsFor({ tier: "currentProject", sourceId: "local", items: rows(3) })).toBe(
      true,
    );
    expect(emitter.rowsFor({ tier: "otherProjectFiles", sourceId: "local", items: rows(4) })).toBe(
      true,
    );
    expect(emitter.rowsFor({ tier: "otherProjectFiles", sourceId: "x", items: rows(4, "s") })).toBe(
      false,
    );
    expect(updates.flatMap((update) => update.items).map((item) => item.id)).toEqual([
      "r0",
      "r1",
      "r2",
      "r3",
      "s0",
    ]);
    expect(updates.at(-1)).toMatchObject({ truncated: true, state: "partial" });
  });

  it("emits nothing once the query is aborted", () => {
    const updates: SystemSearchTierUpdate[] = [];
    const controller = new AbortController();
    const emitter = new SystemSearchEmitter("q", controller.signal, (u) => updates.push(u));
    controller.abort();
    emitter.rowsFor({ tier: "currentProject", sourceId: "local", items: rows(1) });
    emitter.state({ tier: "currentProject", sourceId: "local", state: "done" });
    expect(updates).toEqual([]);
  });
});
