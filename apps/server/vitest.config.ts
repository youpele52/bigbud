import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";
import { PROBE_OUTPUT_ENV } from "./scripts/serverTestGroups.guard.types.ts";
import { escapeGlob, readParallelTestFiles } from "./scripts/serverTestGroups.manifest.ts";

// Server test groups
// ------------------
// Many server tests use real SQLite, git, child processes, PTYs, sockets, and
// temp worktrees. Those flake when run in parallel, so they run one file at a
// time in the `integration` project. Test files that touch none of those run
// in parallel in the `unit` project, which runs first (lower `groupOrder`).
//
// The `unit` lists (`vitest.unit-files/*.txt`) are generated from probe runs by
// `bun run --cwd apps/server test:groups` and are never edited by hand. A file
// that is not listed runs in `integration`, so new tests are serial until a
// probe shows they are safe. The guard setup file keeps the list honest: a
// `unit` file that spawns a process, opens SQLite, uses the network, or writes
// outside its own mkdtemp directory fails with instructions to re-probe it.
//
// Run a single group with `vitest run --project unit` or
// `vitest run --project integration`.
const GUARD_SETUP_FILE = "./scripts/serverTestGroups.guard.ts";
const probing = process.env[PROBE_OUTPUT_ENV] !== undefined;
const unitFiles = probing ? [] : readParallelTestFiles(import.meta.dirname).map(escapeGlob);

const unitProject = {
  extends: true,
  test: {
    name: "unit",
    include: unitFiles,
    setupFiles: [GUARD_SETUP_FILE],
    fileParallelism: true,
    sequence: { groupOrder: 0 },
  },
} as const;

const integrationProject = {
  extends: true,
  test: {
    name: "integration",
    exclude: [...configDefaults.exclude, ...unitFiles],
    // Probe runs record what every file touches instead of failing.
    setupFiles: probing ? [GUARD_SETUP_FILE] : [],
    fileParallelism: probing,
    sequence: { groupOrder: 1 },
  },
} as const;

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide parallel runs they regularly exceed the default 15s budget.
      testTimeout: 60_000,
      hookTimeout: 60_000,
      projects: unitFiles.length > 0 ? [unitProject, integrationProject] : [integrationProject],
    },
  }),
);
