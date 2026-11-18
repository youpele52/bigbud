/**
 * One conformance run (WP-5D): the backend row, then per provider the status rows and, when
 * the provider is `ready`, each session row on its own thread. Cleanup always runs.
 *
 * Safety: no provider settings are changed, no vendor installer runs, only Copilot is ever
 * provisioned and only with `provisionCopilot`, and session rows never run for a provider that
 * is not `ready` (for OpenCode v2 that means its shared service is already healthy; the
 * harness never starts it).
 */
import type { RpcClient } from "../remoteBackendMeasure.client.ts";
import { cleanupRun, type CleanupTiming } from "./cleanup.ts";
import type { ConformanceBackend } from "./client.ts";
import { result, type Provider, type RowDefinition, type RowId, type RowResult } from "./rows.ts";
import { makeTokens, writeFixtures, type ProviderContext } from "./rows.context.ts";
import { disconnectReplayRow, duplicateReceiptRow } from "./rows.recovery.ts";
import {
  authStateRow,
  installReuseRow,
  provisionCopilot,
  readStatus,
  versionRejectionRow,
  type ProvisioningEntry,
} from "./rows.status.ts";
import {
  approvalRow,
  attachmentRow,
  cancelRow,
  questionRow,
  textTurnRow,
  toolUseRow,
} from "./rows.turns.ts";
import { createProject, errorText, type Timing } from "./session.ts";
import type { Journal, Workspace } from "./workspace.ts";

export interface RunInput {
  readonly backend: ConformanceBackend;
  readonly workspace: Workspace;
  readonly journal: Journal;
  readonly providers: ReadonlyArray<Provider>;
  readonly rows: ReadonlyArray<RowDefinition>;
  readonly timing: Timing;
  readonly cleanupTiming?: CleanupTiming;
  /** `--model provider=slug` overrides; otherwise the provider's first available model. */
  readonly models: Readonly<Partial<Record<Provider, string>>>;
  readonly provisionCopilot: boolean;
  readonly expectNeedsAuth: ReadonlySet<Provider>;
  readonly log?: (line: string) => void;
}

export interface RunOutput {
  readonly results: ReadonlyArray<RowResult>;
  readonly backendVersion: string | null;
  readonly cleanupProblems: ReadonlyArray<string>;
}

const SESSION_ROWS: Partial<Record<RowId, (context: ProviderContext) => Promise<RowResult>>> = {
  "text-turn": textTurnRow,
  attachment: attachmentRow,
  "tool-use": toolUseRow,
  approval: approvalRow,
  question: questionRow,
  cancel: cancelRow,
  "disconnect-replay": disconnectReplayRow,
  "duplicate-receipt": duplicateReceiptRow,
};

async function advertisedModels(rpc: RpcClient): Promise<Map<string, string>> {
  const config = (await rpc.call("server.getConfig", {})) as {
    providers?: ReadonlyArray<{
      provider: string;
      models?: ReadonlyArray<{ slug: string; availability?: string }>;
    }>;
  };
  const models = new Map<string, string>();
  for (const entry of config.providers ?? []) {
    const model = entry.models?.find((candidate) => candidate.availability !== "requires-setup");
    if (model) models.set(entry.provider, model.slug);
  }
  return models;
}

async function runProvider(
  input: RunInput,
  rpc: RpcClient,
  provider: Provider,
  shared: {
    projectId: string | null;
    models: Map<string, string>;
    tokens: ReturnType<typeof makeTokens>;
  },
): Promise<RowResult[]> {
  const wanted = (id: RowId) => input.rows.some((row) => row.id === id);
  const results: RowResult[] = [];
  let provisioned: Awaited<ReturnType<typeof provisionCopilot>> | null = null;
  if (provider === "copilot" && input.provisionCopilot) {
    try {
      provisioned = await provisionCopilot(rpc, Math.max(input.timing.pollMs, 1000));
    } catch (error) {
      provisioned = { outcome: `error: ${errorText(error)}`, jobPhase: null };
    }
  }
  let entry: ProvisioningEntry;
  try {
    entry = await readStatus(rpc, provider);
  } catch (error) {
    const reason = `provisioning status failed: ${errorText(error)}`;
    return input.rows
      .filter((row) => row.scope === "provider")
      .map((row) => result(row.id, provider, "fail", reason));
  }
  if (wanted("install-reuse"))
    results.push(await installReuseRow(input.backend, provider, entry, provisioned));
  if (wanted("auth-state"))
    results.push(authStateRow(provider, entry, input.expectNeedsAuth.has(provider)));
  const model = input.models[provider] ?? shared.models.get(provider);
  const blocked =
    entry.state !== "ready"
      ? `provider state ${entry.state}`
      : !model
        ? "no model advertised; pass --model provider=slug"
        : shared.projectId === null
          ? "conformance project was not created"
          : null;
  for (const row of input.rows) {
    const run = SESSION_ROWS[row.id];
    if (!run) continue;
    if (blocked) {
      results.push(result(row.id, provider, "not-run", blocked, { state: entry.state }));
      continue;
    }
    input.log?.(`${provider}: ${row.id}`);
    results.push(
      await run({
        backend: input.backend,
        rpc,
        provider,
        model: model!,
        projectId: shared.projectId!,
        journal: input.journal,
        workspace: input.workspace,
        timing: input.timing,
        tokens: shared.tokens,
      }),
    );
  }
  return results;
}

export async function runConformance(input: RunInput): Promise<RunOutput> {
  const results: RowResult[] = [];
  let backendVersion: string | null = null;
  try {
    backendVersion = (await input.backend.handshake()).backendVersion;
  } catch {
    // The version-rejection row reports handshake failures.
  }
  if (input.rows.some((row) => row.id === "version-rejection"))
    results.push(await versionRejectionRow(input.backend));
  const rpc = await input.backend.connect();
  let cleanupProblems: ReadonlyArray<string> = [];
  try {
    const tokens = makeTokens();
    const models = await advertisedModels(rpc);
    let projectId: string | null = null;
    if (input.rows.some((row) => row.needsSession)) {
      try {
        await writeFixtures(input.workspace, tokens);
        projectId = await createProject(rpc, input.journal, input.workspace.projectRoot);
      } catch (error) {
        input.log?.(`project setup failed: ${errorText(error)}`);
      }
    }
    for (const provider of input.providers)
      results.push(...(await runProvider(input, rpc, provider, { projectId, models, tokens })));
  } finally {
    cleanupProblems = await cleanupRun(
      rpc,
      input.journal.get(),
      input.workspace,
      input.cleanupTiming,
    );
    rpc.close();
  }
  return { results, backendVersion, cleanupProblems };
}
