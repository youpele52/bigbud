import type { SystemSearchHit } from "@bigbud/contracts/search/systemSearch.ts";
import { describe, expect, it, vi } from "vitest";

import { openWithSystemDefault } from "~/lib/openSystemPath";

import {
  canRevealSearchResult,
  describeSystemOpenResult,
  planSearchResultOpen,
} from "./SearchPalette.open.logic";

const REMOTE = "ssh:host=box&transport=agent";

function row(path: string, overrides: Partial<SystemSearchHit> = {}): SystemSearchHit {
  return {
    id: `otherProjectFiles:name:local:/work/app/${path}`,
    kind: "name",
    executionTargetId: "local",
    root: "/work/app",
    path,
    ...overrides,
  };
}

describe("planSearchResultOpen", () => {
  it("keeps the in-app routing for types bigbud can show, with the matched line", () => {
    expect(planSearchResultOpen(row("src/a.ts", { kind: "content", line: 4, column: 2 }))).toEqual({
      action: "in-app",
      target: "/work/app/src/a.ts:4:2",
      root: "/work/app",
      kind: "file",
      executionTargetId: "local",
    });
    expect(planSearchResultOpen(row("docs/spec.pdf"))).toMatchObject({ action: "in-app" });
    expect(planSearchResultOpen(row("src", { isDirectory: true }))).toMatchObject({
      action: "in-app",
      kind: "directory",
    });
    expect(planSearchResultOpen(row("src/a.ts", { executionTargetId: REMOTE }))).toMatchObject({
      action: "in-app",
      executionTargetId: REMOTE,
    });
  });

  it("sends unsupported local types, executables included, to the desktop shell", () => {
    for (const path of ["report.docx", "song.mp3", "Tool.exe", "Setup.dmg", "archive.zip"]) {
      expect(planSearchResultOpen(row(path))).toEqual({
        action: "system",
        absolutePath: `/work/app/${path}`,
      });
    }
  });

  it("never loads this-computer rows into bigbud panels, even text files", () => {
    const outside = row("notes.txt", {
      id: "thisComputer:name:local:/Users/me/Documents/notes.txt",
      root: "/Users/me/Documents",
    });
    expect(planSearchResultOpen(outside)).toEqual({
      action: "system",
      absolutePath: "/Users/me/Documents/notes.txt",
    });
  });

  it("does not hand remote binaries to a local app", () => {
    expect(planSearchResultOpen(row("report.docx", { executionTargetId: REMOTE }))).toEqual({
      action: "remote-unsupported",
    });
  });

  it("offers Reveal only for local rows in the desktop app", () => {
    expect(canRevealSearchResult(row("a.ts"), true)).toBe(true);
    expect(canRevealSearchResult(row("a.ts"), false)).toBe(false);
    expect(canRevealSearchResult(row("a.ts", { executionTargetId: REMOTE }), true)).toBe(false);
  });
});

describe("system open outcomes", () => {
  it("reveals executables instead of launching them and explains why", async () => {
    const bridge = {
      openPath: vi.fn(async () => ({ status: "revealed" as const, launchable: true })),
      showItemInFolder: vi.fn(),
    };
    const plan = planSearchResultOpen(row("Tool.exe"));
    if (plan.action !== "system") throw new Error("expected system open");
    const outcome = await openWithSystemDefault(plan.absolutePath, bridge);
    expect(bridge.openPath).toHaveBeenCalledWith("/work/app/Tool.exe");
    expect(outcome).toEqual({ kind: "revealed-instead", reason: "launchable" });
    expect(describeSystemOpenResult(outcome)).toMatchObject({
      title: "Revealed instead of opened",
    });
  });

  it("hides host actions in browsers and explains refusals", async () => {
    expect(await openWithSystemDefault("/work/app/a.docx", undefined)).toEqual({
      kind: "unavailable-in-browser",
    });
    expect(describeSystemOpenResult({ kind: "unavailable-in-browser" })?.type).toBe("warning");
    expect(describeSystemOpenResult({ kind: "refused", reason: "inaccessible" })?.title).toBe(
      "bigbud will not open this file",
    );
    expect(describeSystemOpenResult({ kind: "opened" })).toBeNull();
  });
});
