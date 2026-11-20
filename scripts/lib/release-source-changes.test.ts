import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { releasePackageFiles } from "./release-package-stamp.ts";
import { releaseSourceChanges, releaseSourceProvenance } from "./release-source-changes.ts";

const RELEASE = "0.4.0-beta.1";
const SERVER = "apps/server/package.json";
const STAMPER = fileURLToPath(new URL("../update-release-package-versions.ts", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args],
    { cwd: repo, encoding: "utf8" },
  ).trim();

function write(repo: string, path: string, text: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

const canonical = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function fixtureRepo(format: (value: unknown) => string = canonical): string {
  const repo = mkdtempSync(join(tmpdir(), "bigbud-release-source-"));
  directories.push(repo);
  git(repo, "init", "--quiet");
  for (const file of releasePackageFiles)
    write(repo, file, format({ name: file, version: "0.3.0", scripts: { build: "x" } }));
  write(repo, "packages/shared/package.json", canonical({ name: "shared", version: "0.3.0" }));
  write(repo, "README.md", "readme\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
  return repo;
}

function edit(repo: string, path: string, change: (json: Record<string, unknown>) => void) {
  const json = JSON.parse(readFileSync(join(repo, path), "utf8")) as Record<string, unknown>;
  change(json);
  write(repo, path, canonical(json));
}

/** Runs the real stamping CLI exactly as the release workflow does. */
const stamp = (repo: string, version = RELEASE) =>
  execFileSync(process.execPath, [STAMPER, version, "--root", repo], { encoding: "utf8" });

describe("releaseSourceChanges", () => {
  it("treats a clean checkout as clean", () => {
    expect(releaseSourceChanges(fixtureRepo(), RELEASE)).toEqual({ unexpected: [], stamped: [] });
  });

  it("accepts exactly the release stamp, including the stamper's own reformatting", () => {
    for (const format of [canonical, (value: unknown) => JSON.stringify(value)]) {
      const repo = fixtureRepo(format);
      stamp(repo, `v${RELEASE}`);
      const changes = releaseSourceChanges(repo, RELEASE);
      expect(changes.unexpected).toEqual([]);
      expect(changes.stamped.toSorted()).toEqual([...releasePackageFiles].toSorted());
    }
  });

  it("treats a stamp for a different version as dirty", () => {
    const repo = fixtureRepo();
    stamp(repo, "0.4.0-beta.2");
    const changes = releaseSourceChanges(repo, RELEASE);
    expect(changes.stamped).toEqual([]);
    expect(changes.unexpected.toSorted()).toEqual(
      releasePackageFiles.map((file) => ` M ${file}`).toSorted(),
    );
    // A non-release version never expects a stamp, and does not throw.
    expect(releaseSourceChanges(repo, "0.3.0-ci.7.1").unexpected).toHaveLength(4);
  });

  it("treats any other change inside a stamped file as dirty", () => {
    const repo = fixtureRepo();
    stamp(repo);
    edit(repo, "apps/web/package.json", (json) => (json.scripts = { build: "evil" }));
    const changes = releaseSourceChanges(repo, RELEASE);
    expect(changes.unexpected).toEqual([" M apps/web/package.json"]);
    expect(changes.stamped).not.toContain("apps/web/package.json");
    // When HEAD already carries the release identity, no change to the file is expected.
    git(repo, "commit", "--quiet", "--no-gpg-sign", "-am", "stamped");
    edit(repo, "apps/web/package.json", (json) => (json.scripts = { build: "worse" }));
    expect(releaseSourceChanges(repo, RELEASE).unexpected).toEqual([" M apps/web/package.json"]);
  });

  it("requires the full stamp: the server release tag and the stamper's exact bytes", () => {
    const repo = fixtureRepo();
    edit(repo, SERVER, (json) => (json.version = RELEASE));
    expect(releaseSourceChanges(repo, RELEASE).unexpected).toEqual([` M ${SERVER}`]);
    stamp(repo);
    write(repo, SERVER, readFileSync(join(repo, SERVER), "utf8").replaceAll("  ", "    "));
    expect(releaseSourceChanges(repo, RELEASE).unexpected).toEqual([` M ${SERVER}`]);
  });

  it("treats unrelated, untracked, staged and unlisted package changes as dirty", () => {
    const repo = fixtureRepo();
    stamp(repo);
    write(repo, "README.md", "changed\n");
    write(repo, "notes.txt", "new\n");
    edit(repo, "packages/shared/package.json", (json) => (json.version = RELEASE));
    git(repo, "add", "apps/desktop/package.json");
    const changes = releaseSourceChanges(repo, RELEASE);
    expect(changes.unexpected.toSorted()).toEqual([
      " M README.md",
      " M packages/shared/package.json",
      "?? notes.txt",
      "M  apps/desktop/package.json",
    ]);
    expect(changes.stamped).not.toContain("apps/desktop/package.json");
  });

  it("reports renames as dirty without misreading the next entry", () => {
    const repo = fixtureRepo();
    git(repo, "mv", "README.md", "MOVED.md");
    write(repo, "notes.txt", "new\n");
    expect(releaseSourceChanges(repo, RELEASE).unexpected).toEqual([
      "R  README.md -> MOVED.md",
      "?? notes.txt",
    ]);
  });
});

describe("releaseSourceProvenance", () => {
  it("records the commit and the stamp, not +dirty, for a stamped release tree", () => {
    const repo = fixtureRepo();
    const commit = git(repo, "rev-parse", "HEAD");
    expect(releaseSourceProvenance(repo, RELEASE)).toEqual({ sourceRevision: commit });
    stamp(repo);
    expect(releaseSourceProvenance(repo, RELEASE)).toEqual({
      sourceRevision: commit,
      sourceReleaseStamp: {
        version: RELEASE,
        tag: `v${RELEASE}`,
        files: [...releasePackageFiles].toSorted(),
      },
    });
    write(repo, "notes.txt", "new\n");
    expect(releaseSourceProvenance(repo, RELEASE)).toEqual({ sourceRevision: `${commit}+dirty` });
  });

  it("is undefined outside a git checkout", () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-release-source-"));
    directories.push(directory);
    expect(releaseSourceProvenance(directory, RELEASE)).toBeUndefined();
  });
});

describe("check-release-source-tree CLI", () => {
  it("rejects a missing version", () => {
    const cli = fileURLToPath(new URL("../check-release-source-tree.ts", import.meta.url));
    expect(() => execFileSync(process.execPath, [cli], { stdio: "pipe" })).toThrow(
      /Usage: node scripts\/check-release-source-tree.ts <version>/,
    );
  });
});
