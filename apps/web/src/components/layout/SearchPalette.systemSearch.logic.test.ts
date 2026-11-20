import type {
  SystemSearchHit,
  SystemSearchQueryInput,
  SystemSearchTierUpdate,
} from "@bigbud/contracts/search/systemSearch.ts";
import { describe, expect, it } from "vitest";

import { describeSearchNotice } from "./SearchPalette.notices.logic";
import {
  applySystemSearchUpdate,
  createSystemSearchRunner,
  EMPTY_SYSTEM_SEARCH_VIEW,
  isSystemSearchTierPending,
  isThisComputerSearchOn,
  nextSystemSearchPage,
  startSystemSearchView,
  systemSearchNotices,
  systemSearchTierRows,
  systemSearchTiersFor,
  type SystemSearchView,
} from "./SearchPalette.systemSearch.logic";

const REMOTE = "ssh:host=box&user=me&transport=agent";

function row(id: string): SystemSearchHit {
  return { id, kind: "name", executionTargetId: "local", root: "/r", path: id };
}

function update(overrides: Partial<SystemSearchTierUpdate>): SystemSearchTierUpdate {
  return {
    queryId: "q1",
    tier: "otherProjectFiles",
    sourceId: "local",
    items: [],
    state: "partial",
    truncated: false,
    ...overrides,
  };
}

describe("applySystemSearchUpdate", () => {
  it("appends rows without reordering, even when an earlier source answers late", () => {
    let view = startSystemSearchView("q1");
    view = applySystemSearchUpdate(
      view,
      update({ sourceId: REMOTE, items: [row("r1"), row("r2")] }),
    );
    const shown = systemSearchTierRows(view, "otherProjectFiles").map((item) => item.id);
    view = applySystemSearchUpdate(view, update({ items: [row("l1")] }));
    view = applySystemSearchUpdate(
      view,
      update({ sourceId: REMOTE, items: [row("r2"), row("r3")] }),
    );
    const ids = systemSearchTierRows(view, "otherProjectFiles").map((item) => item.id);
    // Local rows sort before remote rows; earlier rows keep their relative order.
    expect(ids).toEqual(["l1", "r1", "r2", "r3"]);
    expect(ids.filter((id) => shown.includes(id))).toEqual(shown);
  });

  it("keeps the local source first whatever the remote id", () => {
    let view = startSystemSearchView("q1");
    view = applySystemSearchUpdate(view, update({ sourceId: "devbox", items: [row("d1")] }));
    view = applySystemSearchUpdate(view, update({ items: [row("l1")] }));
    expect(view.sources.map((source) => source.sourceId)).toEqual(["local", "devbox"]);
  });

  it("drops updates from a superseded query", () => {
    const view = startSystemSearchView("q2");
    expect(applySystemSearchUpdate(view, update({ items: [row("late")] }))).toBe(view);
  });

  it("tracks pending sources and the final state", () => {
    let view = startSystemSearchView("q1");
    expect(isSystemSearchTierPending(view, "currentProject")).toBe(true);
    view = applySystemSearchUpdate(view, update({ tier: "currentProject", state: "searching" }));
    view = applySystemSearchUpdate(view, update({ tier: "currentProject", items: [row("a")] }));
    expect(isSystemSearchTierPending(view, "currentProject")).toBe(false);
    view = applySystemSearchUpdate(view, update({ tier: "currentProject", state: "done" }));
    expect(view.sources[0]).toMatchObject({ state: "done", items: [row("a")] });
    expect(isSystemSearchTierPending(EMPTY_SYSTEM_SEARCH_VIEW, "currentProject")).toBe(false);
  });

  it("lists one notice per source and reason", () => {
    let view = startSystemSearchView("q1");
    for (const tier of ["otherProjectFiles", "remoteOutsideProjects"] as const) {
      view = applySystemSearchUpdate(
        view,
        update({ tier, sourceId: REMOTE, state: "unavailable", reason: "not-connected" }),
      );
    }
    const notices = systemSearchNotices(view);
    expect(notices).toHaveLength(1);
    expect(describeSearchNotice(notices[0]!)).toEqual({
      text: "me@box is not connected; connect it to search its files.",
      tone: "amber",
    });
    expect(
      describeSearchNotice({ ...notices[0]!, reason: "agent-update-available" }).text,
    ).toContain("Update its bigbud agent");
    expect(describeSearchNotice({ ...notices[0]!, reason: "error" }).tone).toBe("red");
  });
});

describe("systemSearchTiersFor", () => {
  it("applies the short-query rules and leaves this computer out unless enabled", () => {
    expect(systemSearchTiersFor(" ", { thisComputer: true })).toEqual([]);
    expect(systemSearchTiersFor("a", { thisComputer: true })).toEqual(["currentProject"]);
    expect(systemSearchTiersFor("ab", { thisComputer: false })).toEqual([
      "currentProject",
      "otherProjectFiles",
      "remoteOutsideProjects",
    ]);
    expect(systemSearchTiersFor("ab", { thisComputer: true })).toContain("thisComputer");
  });

  it("leaves the current project out for Mod+P's local list", () => {
    expect(systemSearchTiersFor("a", { thisComputer: true, currentProject: false })).toEqual([]);
    expect(systemSearchTiersFor("ab", { thisComputer: false, currentProject: false })).toEqual([
      "otherProjectFiles",
      "remoteOutsideProjects",
    ]);
  });

  it("searches this computer only when it is on and File Access allows it", () => {
    const on = (thisComputer: boolean, fileAccessLevel: string) =>
      isThisComputerSearchOn({ search: { thisComputer, fileAccessLevel } });
    expect(on(true, "common-folders")).toBe(true);
    expect(on(true, "none")).toBe(false);
    expect(on(false, "unrestricted")).toBe(false);
  });
});

describe("paging", () => {
  it("offers the next page only for a settled, truncated tier and keeps rows on page loads", async () => {
    const calls: Array<{
      input: SystemSearchQueryInput;
      emit: (update: SystemSearchTierUpdate) => void;
      signal: AbortSignal;
      finish: () => void;
    }> = [];
    let view: SystemSearchView = EMPTY_SYSTEM_SEARCH_VIEW;
    let nextId = 0;
    const runner = createSystemSearchRunner(
      (input, emit, signal) =>
        new Promise<void>((resolve) => calls.push({ input, emit, signal, finish: resolve })),
      (change) => {
        view = change(view);
      },
      () => `q${++nextId}`,
    );
    runner.run({ query: "ab", mode: "fileNames", tiers: ["otherProjectFiles", "thisComputer"] });
    calls[0]!.emit(update({ queryId: "q1", items: [row("a"), row("b")] }));
    calls[0]!.emit(update({ queryId: "q1", truncated: true }));
    // Not offered while the query still runs.
    expect(nextSystemSearchPage(view, "otherProjectFiles")).toBeNull();
    calls[0]!.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(nextSystemSearchPage(view, "otherProjectFiles")).toBe(1);
    expect(nextSystemSearchPage(view, "thisComputer")).toBeNull();

    runner.more({ query: "ab", mode: "fileNames", page: 1 }, "otherProjectFiles");
    expect(calls[1]!.input).toMatchObject({
      queryId: "q2",
      tiers: ["otherProjectFiles"],
      page: 1,
      mode: "fileNames",
    });
    expect(systemSearchTierRows(view, "otherProjectFiles").map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
    expect(isSystemSearchTierPending(view, "otherProjectFiles")).toBe(true);
    // Earlier rows come back first and are dropped by stable ID; new ones append.
    calls[1]!.emit(update({ queryId: "q2", items: [row("a"), row("b"), row("c")] }));
    calls[1]!.emit(update({ queryId: "q2", state: "done" }));
    calls[1]!.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(systemSearchTierRows(view, "otherProjectFiles").map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(nextSystemSearchPage(view, "otherProjectFiles")).toBeNull();
    expect(view.pages).toEqual({ otherProjectFiles: 1 });
  });
});

describe("createSystemSearchRunner", () => {
  it("aborts the superseded query and ignores its late updates", async () => {
    const calls: Array<{
      input: SystemSearchQueryInput;
      emit: (update: SystemSearchTierUpdate) => void;
      signal: AbortSignal;
      finish: () => void;
    }> = [];
    let view: SystemSearchView = EMPTY_SYSTEM_SEARCH_VIEW;
    let nextId = 0;
    const runner = createSystemSearchRunner(
      (input, emit, signal) =>
        new Promise<void>((resolve) => calls.push({ input, emit, signal, finish: resolve })),
      (change) => {
        view = change(view);
      },
      () => `q${++nextId}`,
    );
    runner.run({ query: "ab", tiers: ["currentProject"] });
    runner.run({ query: "abc", tiers: ["currentProject"] });
    expect(calls.map((call) => call.input.queryId)).toEqual(["q1", "q2"]);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);
    calls[0]!.emit(update({ queryId: "q1", items: [row("stale")] }));
    calls[1]!.emit(update({ queryId: "q2", tier: "currentProject", items: [row("fresh")] }));
    expect(systemSearchTierRows(view, "currentProject").map((item) => item.id)).toEqual(["fresh"]);
    calls[0]!.finish();
    calls[1]!.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(view).toMatchObject({ queryId: "q2", finished: true, failed: false });

    runner.run(null);
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(view).toBe(EMPTY_SYSTEM_SEARCH_VIEW);
    runner.run({ query: "abcd", tiers: ["currentProject"] });
    runner.cancel();
    expect(calls[2]!.signal.aborted).toBe(true);
  });
});
