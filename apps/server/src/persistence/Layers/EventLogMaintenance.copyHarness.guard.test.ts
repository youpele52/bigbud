import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bigbudStateRoots, refuseLiveDatabase } from "./EventLogMaintenance.copyHarness.guard.ts";

const dirs: Array<string> = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-guard-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("refuseLiveDatabase", () => {
  it("refuses the live state database and anything else under a bigbud home", () => {
    const home = tempDir();
    const roots = bigbudStateRoots({}, home);
    mkdirSync(join(home, ".bigbud", "userdata"), { recursive: true });
    expect(refuseLiveDatabase(join(home, ".bigbud", "userdata", "state.sqlite"), roots)).toMatch(
      /inside the bigbud state directory/,
    );
    expect(refuseLiveDatabase(join(home, ".bigbud", "dev", "state.sqlite"), roots)).not.toBeNull();
  });

  it("refuses a configured BIGBUD_HOME or legacy T3CODE_HOME", () => {
    const custom = tempDir();
    const legacy = tempDir();
    const roots = bigbudStateRoots({ BIGBUD_HOME: custom, T3CODE_HOME: legacy }, tempDir());
    expect(refuseLiveDatabase(join(custom, "state.sqlite"), roots)).not.toBeNull();
    expect(refuseLiveDatabase(join(legacy, "userdata", "state.sqlite"), roots)).not.toBeNull();
  });

  it("refuses a symlink that resolves into a bigbud home", () => {
    const home = tempDir();
    const live = join(home, ".bigbud", "userdata");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "state.sqlite"), "");
    const link = join(tempDir(), "copy.sqlite");
    symlinkSync(join(live, "state.sqlite"), link);
    expect(refuseLiveDatabase(link, bigbudStateRoots({}, home))).not.toBeNull();
  });

  it("refuses a file next to a backend.lock wherever it is", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "backend.lock"), "");
    expect(refuseLiveDatabase(join(dir, "state.sqlite"), [])).toMatch(/backend\.lock/);
  });

  it("accepts a copy in its own directory", () => {
    const dir = tempDir();
    expect(
      refuseLiveDatabase(join(dir, "copy.sqlite"), bigbudStateRoots({}, tempDir())),
    ).toBeNull();
  });
});
