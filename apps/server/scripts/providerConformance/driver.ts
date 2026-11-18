/**
 * Provider conformance harness (WP-5D, M4). Drives a remote backend through its authenticated
 * client socket, per provider, and writes a dated, redacted JSON + markdown matrix.
 *
 *   On the host (local client socket, the graph's private Node):
 *     ~/runtime/backend/runtime/node driver.ts --authority <id> [options]
 *   From the laptop (SSH relay, this checkout):
 *     node apps/server/scripts/providerConformance/driver.ts --transport relay --ssh <target> \
 *       --authority <id> --relay-node <abs> --relay-entry <abs> --tuple <label> [options]
 *   No backend at all:
 *     node apps/server/scripts/providerConformance/driver.ts --self-test
 *
 * Options: --providers a,b  --rows a,b  --model provider=slug (repeatable)  --out-dir <dir>
 * --provision-copilot  --expect-needs-auth a,b  --turn-timeout-ms <n>  --dry-run
 * --restore <localWorkDir>  --ws-module <dir>  --backend-home <dir>  --graph-root <dir>.
 * See docs/reports/2026-11-18-provider-conformance-harness.md for the M4 checklist.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { cleanupRun } from "./cleanup.ts";
import {
  localSocketBackend,
  resolveWebSocket,
  sshRelayBackend,
  type ConformanceBackend,
} from "./client.ts";
import { makeMockBackend } from "./mockBackend.ts";
import { buildReport, renderMarkdown, writeReport, type RunMode } from "./report.ts";
import { selectProviders, selectRows, type Provider } from "./rows.ts";
import { runConformance } from "./run.ts";
import type { Timing } from "./session.ts";
import {
  WORK_DIR_PREFIX,
  createRemoteWorkDir,
  makeJournal,
  readJournal,
  workspaceFor,
  type WorkspaceLocation,
} from "./workspace.ts";

const { values } = parseArgs({
  options: {
    transport: { type: "string", default: "local" },
    authority: { type: "string" },
    "backend-home": { type: "string", default: join(homedir(), "backend-data") },
    "graph-root": { type: "string", default: join(homedir(), "runtime", "backend") },
    "ws-module": { type: "string" },
    ssh: { type: "string" },
    "relay-node": { type: "string" },
    "relay-entry": { type: "string" },
    tuple: { type: "string" },
    providers: { type: "string" },
    rows: { type: "string" },
    model: { type: "string", multiple: true, default: [] },
    "out-dir": { type: "string", default: join(homedir(), "bigbud-conformance-results") },
    "work-dir": { type: "string" },
    "turn-timeout-ms": { type: "string", default: "180000" },
    "provision-copilot": { type: "boolean", default: false },
    "expect-needs-auth": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "self-test": { type: "boolean", default: false },
    restore: { type: "string" },
  },
});

const SELF_TEST_PROVIDERS = "codex,claudeAgent,copilot,muse,pi";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "")
  .replace(/\.\d+Z$/u, "Z");

function parseModels(entries: ReadonlyArray<string>): Partial<Record<Provider, string>> {
  const models: Partial<Record<Provider, string>> = {};
  for (const entry of entries) {
    const [provider, slug] = entry.split("=", 2);
    if (!provider || !slug) throw new Error("--model takes provider=slug.");
    models[selectProviders(provider)[0]!] = slug;
  }
  return models;
}

function liveBackend(): { backend: ConformanceBackend; location: WorkspaceLocation | null } {
  const authorityId = values.authority;
  if (!authorityId || !/^[0-9a-f]{32}$/u.test(authorityId))
    throw new Error("--authority <32 hex characters> is required (see `bigbud backend status`).");
  if (values.transport === "relay") {
    if (!values.ssh || !values["relay-node"] || !values["relay-entry"] || !values.tuple)
      throw new Error("--transport relay needs --ssh, --relay-node, --relay-entry and --tuple.");
    const WebSocket = resolveWebSocket({ wsModule: values["ws-module"], repoRoot });
    return {
      backend: sshRelayBackend({
        WebSocket,
        sshTarget: values.ssh,
        relayNode: values["relay-node"],
        relayEntry: values["relay-entry"],
        authorityId,
      }),
      location: null,
    };
  }
  if (values.transport !== "local") throw new Error("--transport is local or relay.");
  const graphRoot = String(values["graph-root"]);
  const WebSocket = resolveWebSocket({ wsModule: values["ws-module"], graphRoot, repoRoot });
  const token = readFileSync(
    join(homedir(), ".bigbud", "backend-services", authorityId, "client-token"),
    "utf8",
  ).trim();
  const socketPath = join(String(values["backend-home"]), "userdata", "remote-backend.sock");
  return {
    backend: localSocketBackend({ WebSocket, socketPath, token }),
    location: {
      kind: "local",
      workDir: values["work-dir"] ?? join(homedir(), `${WORK_DIR_PREFIX}${stamp}`),
    },
  };
}

async function restore(localWorkDir: string) {
  const journal = readJournal(localWorkDir);
  const { backend } = liveBackend();
  const rpc = await backend.connect();
  try {
    const problems = await cleanupRun(rpc, journal, workspaceFor(journal.location));
    console.log(JSON.stringify({ restored: localWorkDir, problems }, null, 2));
    if (problems.length > 0) process.exitCode = 3;
  } finally {
    rpc.close();
  }
}

function dryRun(providers: ReadonlyArray<Provider>, rows: ReturnType<typeof selectRows>) {
  console.log(
    `Dry run (${values["self-test"] ? "self-test" : `transport ${values.transport}`}); nothing is contacted.`,
  );
  for (const row of rows.filter((entry) => entry.scope === "backend"))
    console.log(`  backend: ${row.id}`);
  for (const provider of providers) {
    const steps: string[] = rows.filter((row) => row.scope === "provider").map((row) => row.id);
    if (provider === "copilot" && values["provision-copilot"]) steps.unshift("provision(copilot)");
    console.log(`  ${provider}: ${steps.join(", ")}`);
  }
  console.log("Session rows run only for providers whose provisioning state is `ready`.");
}

async function main() {
  if (values.restore) return restore(values.restore);
  const selfTest = values["self-test"];
  const providers = selectProviders(
    values.providers ?? (selfTest ? SELF_TEST_PROVIDERS : undefined),
  );
  const rows = selectRows(values.rows);
  if (values["dry-run"]) return dryRun(providers, rows);
  const startedAt = new Date().toISOString();
  const turnDeadlineMs = Number(values["turn-timeout-ms"]);
  if (!Number.isInteger(turnDeadlineMs) || turnDeadlineMs < 1000)
    throw new Error("--turn-timeout-ms must be an integer of at least 1000.");
  const timing: Timing = selfTest
    ? { turnDeadlineMs: 10_000, pollMs: 5, cancelAfterMs: 2_000, disconnectMs: 10 }
    : { turnDeadlineMs, pollMs: 500, cancelAfterMs: 20_000, disconnectMs: 2_000 };

  let backend: ConformanceBackend;
  let location: WorkspaceLocation;
  let mockWorkspace = null;
  if (selfTest) {
    const mock = makeMockBackend({});
    backend = mock.backend;
    mockWorkspace = mock.workspace;
    location = { kind: "mock", workDir: join(tmpdir(), `${WORK_DIR_PREFIX}${stamp}`) };
  } else {
    const live = liveBackend();
    backend = live.backend;
    location = live.location ?? {
      kind: "ssh",
      sshTarget: values.ssh!,
      remoteWorkDir: await createRemoteWorkDir(values.ssh!, stamp),
    };
  }
  const localWorkDir =
    location.kind === "ssh"
      ? (values["work-dir"] ?? join(homedir(), `${WORK_DIR_PREFIX}${stamp}`))
      : location.workDir;
  const workspace = mockWorkspace ?? workspaceFor(location);
  mkdirSync(localWorkDir, { recursive: true, mode: 0o700 });
  const journal = makeJournal(localWorkDir, {
    tool: "providerConformance",
    createdAt: startedAt,
    location,
    projectId: null,
    threadIds: [],
  });
  const output = await runConformance({
    backend,
    workspace,
    journal,
    providers,
    rows,
    timing,
    models: parseModels(values.model ?? []),
    provisionCopilot: values["provision-copilot"] || selfTest,
    expectNeedsAuth: new Set(
      values["expect-needs-auth"] ? selectProviders(values["expect-needs-auth"]) : [],
    ),
    log: (line) => console.error(line),
  });
  // The journal stays only while something is left to restore.
  if (output.cleanupProblems.length === 0) rmSync(localWorkDir, { recursive: true, force: true });
  else console.error(`Cleanup incomplete; rerun with --restore ${localWorkDir}`);
  const mode: RunMode = selfTest ? "self-test" : "live";
  const report = buildReport({
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    tuple: selfTest ? "mock" : (values.tuple ?? `${platform()}-${arch()}`),
    transport: backend.kind,
    backendVersion: output.backendVersion,
    providers,
    results: output.results,
    cleanupProblems: output.cleanupProblems,
  });
  const written = writeReport(String(values["out-dir"]), report);
  console.log(renderMarkdown(report));
  console.log(JSON.stringify(written));
  // Self-test: exit 0 when the harness itself works. Live: exit 0 only for a clean candidate.
  const ok = selfTest ? report.counts.fail === 0 : report.acceptance === "candidate";
  if (!ok || output.cleanupProblems.length > 0) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
