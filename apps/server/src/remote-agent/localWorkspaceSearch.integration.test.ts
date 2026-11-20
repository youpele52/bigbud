import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeLocalWorkspaceContentSearch } from "./localWorkspaceSearch.ts";
import { LocalWorkspaceWatchAgent } from "./localWorkspaceWatchAgent.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const binaryPath = join(
  repoRoot,
  "target",
  "debug",
  process.platform === "win32" ? "bigbud-remote-agent.exe" : "bigbud-remote-agent",
);
const temporaryRoots: string[] = [];
const paths = { normalizeWorkspaceRoot: (root: string) => Effect.succeed(root) };

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `bigbud-local-search-${label}-`));
  temporaryRoots.push(root);
  return root;
}

beforeAll(() => {
  const build = spawnSync("cargo", ["build", "--locked", "--package", "bigbud-remote-agent"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) throw new Error("Failed to build the real local workspace agent.");
});

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe("local workspace content search through the real agent", () => {
  it("keeps the projects.searchFileContents result shape, limits and skips", async () => {
    const root = temporaryRoot("shape");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(
      join(root, "src", "example.ts"),
      "export const needle = 1;\nexport const other = 2;\n",
    );
    writeFileSync(join(root, ".hidden.ts"), "const needle = true;\n");
    writeFileSync(join(root, "node_modules", "skipped.ts"), "const needle = false;\n");
    const agent = new LocalWorkspaceWatchAgent({ resolveBinary: () => binaryPath });
    const search = makeLocalWorkspaceContentSearch(agent, paths);
    try {
      const all = await Effect.runPromise(search({ cwd: root, query: "needle", limit: 10 }));
      expect(
        [...all.matches].toSorted((left, right) => left.path.localeCompare(right.path)),
      ).toEqual([
        { path: ".hidden.ts", line: 1, column: 7, lineText: "const needle = true;" },
        { path: "src/example.ts", line: 1, column: 14, lineText: "export const needle = 1;" },
      ]);
      expect(all.truncated).toBe(false);
      expect(all.notice).toBeUndefined();

      const limited = await Effect.runPromise(search({ cwd: root, query: "needle", limit: 1 }));
      expect(limited.matches).toHaveLength(1);
      expect(limited.truncated).toBe(true);

      const exact = await Effect.runPromise(search({ cwd: root, query: "needle", limit: 2 }));
      expect(exact.matches).toHaveLength(2);
      expect(exact.truncated).toBe(false);

      // Always case-insensitive (no smart case): an upper-case query finds the same matches.
      const cased = await Effect.runPromise(search({ cwd: root, query: "Needle", limit: 10 }));
      expect(cased.matches).toEqual(exact.matches);
    } finally {
      agent.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "never spawns rg from PATH for local search",
    async () => {
      const root = temporaryRoot("no-rg");
      writeFileSync(join(root, "file.txt"), "a needle here\n");
      const shim = temporaryRoot("rg-shim");
      const marker = join(shim, "rg-was-run");
      writeFileSync(join(shim, "rg"), `#!/bin/sh\ntouch "${marker}"\nexit 2\n`);
      chmodSync(join(shim, "rg"), 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${shim}${delimiter}${previousPath ?? ""}`;
      const agent = new LocalWorkspaceWatchAgent({ resolveBinary: () => binaryPath });
      try {
        const result = await Effect.runPromise(
          makeLocalWorkspaceContentSearch(agent, paths)({ cwd: root, query: "needle", limit: 10 }),
        );
        expect(result.matches.map((match) => match.path)).toEqual(["file.txt"]);
        expect(existsSync(marker)).toBe(false);
      } finally {
        process.env.PATH = previousPath;
        agent.close();
      }
    },
  );
});
