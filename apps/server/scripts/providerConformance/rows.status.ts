/**
 * Status rows (install reuse, auth state), the opt-in Copilot provisioning step and the
 * backend-scoped version rejection row. None of these starts a provider session.
 *
 * Provisioning: only `server.provisionProvider({ provider: "copilot" })`, only when the user
 * passed `--provision-copilot`, and only over the client socket (the D10 setup-authority
 * surface). Every other provider is observed with `server.getProviderProvisioningStatus`,
 * which never installs anything and never starts OpenCode's shared service.
 */
import type { RpcClient } from "../remoteBackendMeasure.client.ts";
import { CLIENT_RPC_REVISION, rejectedUpgradeStatus, type ConformanceBackend } from "./client.ts";
import { result, type Provider, type RowResult } from "./rows.ts";
import { delay, errorText } from "./session.ts";

export interface ProvisioningEntry {
  readonly provider: string;
  readonly state: string;
  readonly executableSource: string | null;
  readonly authCheck: string;
  readonly authStep: string;
  /** Present on the wire; never copied into results (redaction rule). */
  readonly executablePath?: unknown;
  readonly message?: unknown;
}

const INSTALLED_STATES = new Set(["ready", "needs-auth", "unknown"]);
const COPILOT_JOB_DEADLINE_MS = 15 * 60_000;

export async function readStatus(rpc: RpcClient, provider: Provider): Promise<ProvisioningEntry> {
  const status = (await rpc.call("server.getProviderProvisioningStatus", { provider })) as {
    providers?: ReadonlyArray<ProvisioningEntry>;
  };
  const entry = status.providers?.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`no provisioning entry for ${provider}`);
  return entry;
}

const statusEvidence = (entry: ProvisioningEntry) => ({
  state: entry.state,
  executableSource: entry.executableSource,
  authCheck: entry.authCheck,
});

/** Copilot only, opt-in: start the pinned runtime install and poll the existing job status. */
export async function provisionCopilot(rpc: RpcClient, pollMs: number) {
  const provision = (await rpc.call("server.provisionProvider", { provider: "copilot" })) as {
    outcome: string;
    copilotJob: { id: string; phase: string } | null;
  };
  if (provision.outcome !== "installing") return { outcome: provision.outcome, jobPhase: null };
  const started = performance.now();
  while (performance.now() - started < COPILOT_JOB_DEADLINE_MS) {
    const state = (await rpc.call("server.copilotRuntime", { action: "status" })) as {
      job: { phase: string } | null;
      available: boolean;
    };
    const phase = state.job?.phase ?? (state.available ? "installed" : "unknown");
    if (["installed", "error", "cancelled"].includes(phase))
      return { outcome: provision.outcome, jobPhase: phase };
    await delay(pollMs);
  }
  return { outcome: provision.outcome, jobPhase: "deadline" };
}

/**
 * Install reuse: the installation bigbud resolved is reported, and stays the same across two
 * independent client connections (the reconnect case).
 */
export async function installReuseRow(
  backend: ConformanceBackend,
  provider: Provider,
  first: ProvisioningEntry,
  provisioned: { outcome: string; jobPhase: string | null } | null,
): Promise<RowResult> {
  const started = performance.now();
  const evidence = {
    ...statusEvidence(first),
    ...(provisioned
      ? { provisionOutcome: provisioned.outcome, copilotJobPhase: provisioned.jobPhase }
      : {}),
  };
  if (first.state === "unsupported")
    return result(
      "install-reuse",
      provider,
      "unsupported-by-provider",
      "no bigbud artifact for this tuple",
      evidence,
    );
  if (first.state === "disabled")
    return result(
      "install-reuse",
      provider,
      "not-run",
      "disabled in settings; enable it to test",
      evidence,
    );
  if (first.state === "missing")
    return result(
      "install-reuse",
      provider,
      "fail",
      provider === "copilot" && !provisioned
        ? "missing; rerun with --provision-copilot to install the pinned runtime"
        : "missing; install it on the host with the reported manual command",
      evidence,
    );
  const again = await backend.connect();
  let second: ProvisioningEntry;
  try {
    second = await readStatus(again, provider);
  } finally {
    again.close();
  }
  const stable = second.executableSource === first.executableSource && second.state === first.state;
  if (!INSTALLED_STATES.has(first.state) || first.executableSource === null)
    return result(
      "install-reuse",
      provider,
      "fail",
      `state ${first.state} without an executable source`,
      evidence,
      performance.now() - started,
    );
  return stable
    ? result(
        "install-reuse",
        provider,
        "pass",
        `reused ${first.executableSource} installation`,
        evidence,
        performance.now() - started,
      )
    : result(
        "install-reuse",
        provider,
        "fail",
        "installation changed between connections",
        { ...evidence, secondSource: second.executableSource },
        performance.now() - started,
      );
}

/**
 * Auth required/expired, as far as it is safely observable: bigbud never signs out a user.
 * `needs-auth` must be explicit and carry a sign-in step; an authenticated provider leaves the
 * row not-run unless the user signed it out and passed `--expect-needs-auth <provider>`.
 */
export function authStateRow(
  provider: Provider,
  entry: ProvisioningEntry,
  expectNeedsAuth: boolean,
): RowResult {
  const evidence = { ...statusEvidence(entry), hasAuthStep: entry.authStep.trim().length > 0 };
  if (entry.state === "needs-auth")
    return entry.authStep.trim().length > 0
      ? result(
          "auth-state",
          provider,
          "pass",
          "explicit needs-auth with a manual sign-in step",
          evidence,
        )
      : result("auth-state", provider, "fail", "needs-auth without a sign-in step", evidence);
  if (expectNeedsAuth)
    return result(
      "auth-state",
      provider,
      "fail",
      `expected needs-auth, saw ${entry.state}`,
      evidence,
    );
  if (entry.state === "ready")
    return result(
      "auth-state",
      provider,
      "not-run",
      "authenticated; sign out on the host and rerun with --expect-needs-auth to exercise it",
      evidence,
    );
  return result(
    "auth-state",
    provider,
    "not-run",
    `state ${entry.state}; auth not observable`,
    evidence,
  );
}

/** A client at another RPC revision must be refused at the upgrade with 426. */
export async function versionRejectionRow(backend: ConformanceBackend): Promise<RowResult> {
  const started = performance.now();
  let handshakeRevision: number | null = null;
  try {
    handshakeRevision = (await backend.handshake()).clientRpcRevision;
  } catch (error) {
    return result("version-rejection", "backend", "fail", `handshake failed: ${errorText(error)}`);
  }
  const probe = CLIENT_RPC_REVISION + 1000;
  try {
    const rpc = await backend.connect(probe);
    rpc.close();
    return result("version-rejection", "backend", "fail", `revision ${probe} was accepted`, {
      handshakeRevision,
    });
  } catch (error) {
    const status = rejectedUpgradeStatus(error);
    const evidence = { handshakeRevision, probeRevision: probe, upgradeStatus: status };
    const elapsed = performance.now() - started;
    if (status !== 426)
      return result(
        "version-rejection",
        "backend",
        "fail",
        `expected 426, got ${status ?? "no status"}`,
        evidence,
        elapsed,
      );
    if (handshakeRevision !== CLIENT_RPC_REVISION)
      return result(
        "version-rejection",
        "backend",
        "fail",
        `handshake advertises revision ${handshakeRevision}`,
        evidence,
        elapsed,
      );
    return result(
      "version-rejection",
      "backend",
      "pass",
      "mismatched revision refused with 426",
      evidence,
      elapsed,
    );
  }
}
