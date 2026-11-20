import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeMockBackend, type MockFaults, type MockProviderSpec } from "./mockBackend.ts";
import { selectProviders, selectRows, type Provider, type RowResult } from "./rows.ts";
import { runConformance } from "./run.ts";
import { makeJournal, WORK_DIR_PREFIX } from "./workspace.ts";

export const FAST_TIMING = {
  turnDeadlineMs: 3_000,
  pollMs: 2,
  cancelAfterMs: 1_000,
  disconnectMs: 5,
};
const FAST_CLEANUP = { deadlineMs: 200, pollMs: 2, settleMs: 2 };

/** Run the harness against the in-process mock backend and mock provider. */
export async function runAgainstMock(
  input: {
    readonly faults?: MockFaults;
    readonly providers?: string;
    readonly rows?: string;
    readonly specs?: MockProviderSpec[];
    readonly provisionCopilot?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "bb-conformance-test-"));
  const workDir = join(root, `${WORK_DIR_PREFIX}test`);
  try {
    const mock = makeMockBackend({
      ...(input.faults ? { faults: input.faults } : {}),
      ...(input.specs ? { providers: input.specs } : {}),
    });
    mkdirSync(workDir, { mode: 0o700 });
    const journal = makeJournal(workDir, {
      tool: "providerConformance",
      createdAt: new Date().toISOString(),
      location: { kind: "mock", workDir },
      projectId: null,
      threadIds: [],
    });
    const output = await runConformance({
      backend: mock.backend,
      workspace: mock.workspace,
      journal,
      providers: selectProviders(input.providers ?? "codex,claudeAgent,copilot,muse,pi"),
      rows: selectRows(input.rows),
      timing: FAST_TIMING,
      cleanupTiming: FAST_CLEANUP,
      models: {},
      provisionCopilot: input.provisionCopilot ?? true,
      expectNeedsAuth: new Set<Provider>(),
    });
    return { output, mock, journal: journal.get() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const statusOf = (results: ReadonlyArray<RowResult>, provider: string, row: string) =>
  results.find((entry) => entry.provider === provider && entry.row === row)?.status;
