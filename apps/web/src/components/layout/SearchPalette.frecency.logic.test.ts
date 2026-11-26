import type { SystemSearchHit } from "@bigbud/contracts/search/systemSearch.ts";
import { describe, expect, it } from "vitest";

import { boostOpenedFiles, openedFileKey, openedFileRank } from "./SearchPalette.frecency.logic";

const entry = (path: string) => ({ path, position: null, scrollTop: null });
const row = (root: string, path: string, executionTargetId = "local"): SystemSearchHit => ({
  id: `thisComputer:name:${executionTargetId}:${root}/${path}`,
  kind: "name",
  executionTargetId,
  root,
  path,
});

describe("openedFileRank", () => {
  it("ranks files opened from bigbud by absolute path and machine, most recent first", () => {
    const rank = openedFileRank(
      {
        "project:p:/work/app::local": { entries: [entry("a.ts"), entry("b.ts")], index: 1 },
        "chat:/Users/me/Documents::local": { entries: [entry("notes.md")], index: 0 },
        "chat:/srv/app::ssh:vps": { entries: [entry("a.ts")], index: 0 },
        "isolated:t::local": { entries: [entry("x.ts")], index: 0 },
      },
      ["project:p:/work/app::local", "chat:/Users/me/Documents::local", "chat:/srv/app::ssh:vps"],
    );
    expect([...rank]).toEqual([
      [openedFileKey("ssh:vps", "/srv/app/a.ts"), 0],
      [openedFileKey("local", "/Users/me/Documents/notes.md"), 1],
      [openedFileKey("local", "/work/app/b.ts"), 2],
      [openedFileKey("local", "/work/app/a.ts"), 3],
    ]);
  });
});

describe("boostOpenedFiles", () => {
  it("floats opened files in open order and keeps the server order for the rest", () => {
    const rows = [
      row("/Users/me/Documents", "report.pdf"),
      row("/Users/me/Documents", "notes.md"),
      row("/srv/app", "a.ts", "ssh:vps"),
      row("/srv/app", "a.ts"),
      row("/Users/me/Downloads", "report-2.pdf"),
    ];
    const rank = new Map([
      [openedFileKey("ssh:vps", "/srv/app/a.ts"), 0],
      [openedFileKey("local", "/Users/me/Documents/notes.md"), 1],
    ]);
    expect(
      boostOpenedFiles(rows, rank).map((r) => `${r.executionTargetId}:${r.root}/${r.path}`),
    ).toEqual([
      "ssh:vps:/srv/app/a.ts",
      "local:/Users/me/Documents/notes.md",
      "local:/Users/me/Documents/report.pdf",
      // Same path on another machine is a different file.
      "local:/srv/app/a.ts",
      "local:/Users/me/Downloads/report-2.pdf",
    ]);
    expect(boostOpenedFiles(rows, new Map())).toEqual(rows);
  });
});
