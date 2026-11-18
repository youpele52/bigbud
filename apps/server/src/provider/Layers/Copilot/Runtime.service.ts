import { lstat } from "node:fs/promises";
import type {
  CopilotRuntimeInput,
  CopilotRuntimeState,
} from "@bigbud/contracts/server/copilotRuntime";
import { copilotRuntimeRoot } from "@bigbud/shared/copilotRuntime.paths";
import { COPILOT_RUNTIME_VERSION } from "./Runtime.release.ts";
import { discoverCopilotRuntime, managedCopilotInstallations } from "./Runtime.discovery.ts";
import { acknowledgeCopilotSetup, copilotSetupAcknowledged } from "./Runtime.lifecycle.ts";
import { cancelCopilotJob, readCopilotJob, startCopilotJob } from "./Runtime.jobs.ts";
import { activeCopilotLeases, withCopilotRuntimeLock } from "@bigbud/shared/copilotRuntime.storage";

export interface CopilotRuntimeProviderSettings {
  readonly binaryPath: string;
  readonly enabled: boolean;
}

async function rootExists(root: string): Promise<boolean> {
  try {
    await lstat(root);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Server-authoritative lifecycle status; only explicit install/update actions download bytes.
 * While the provider is disabled, a status read never executes a Copilot binary, never writes
 * state, and never prompts for setup.
 */
export async function copilotRuntimeRequest(
  input: CopilotRuntimeInput,
  provider: CopilotRuntimeProviderSettings,
  root = copilotRuntimeRoot(),
): Promise<CopilotRuntimeState> {
  let error: string | null = null;
  try {
    if (input.action === "acknowledge") await acknowledgeCopilotSetup(root);
    if (input.action === "install" || input.action === "update" || input.action === "uninstall")
      await startCopilotJob(root, input.action === "uninstall");
    if (input.action === "cancel") await cancelCopilotJob(root, input.jobId);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const passive = !provider.enabled && input.action === "status";
  const discovery = await discoverCopilotRuntime(provider.binaryPath, root, {
    probe: provider.enabled,
  });
  const base = {
    ...discovery,
    error,
    diagnostic: discovery.error,
    pinnedVersion: COPILOT_RUNTIME_VERSION,
  };
  if (passive && !(await rootExists(root)))
    return { ...base, managed: [], activeLeases: 0, onboarding: false, job: null };
  if (!passive && (discovery.available || discovery.source !== "missing"))
    await acknowledgeCopilotSetup(root);
  return withCopilotRuntimeLock(root, async () => ({
    ...base,
    managed: await managedCopilotInstallations(root),
    activeLeases: await activeCopilotLeases(root),
    onboarding:
      provider.enabled && discovery.source === "missing" && !(await copilotSetupAcknowledged(root)),
    job: await readCopilotJob(root),
  }));
}
