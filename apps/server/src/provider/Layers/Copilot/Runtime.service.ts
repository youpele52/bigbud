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

/** Server-authoritative lifecycle status; only explicit install/update actions download bytes. */
export async function copilotRuntimeRequest(
  input: CopilotRuntimeInput,
  binaryPath: string,
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
  const discovery = await discoverCopilotRuntime(binaryPath, root);
  if (discovery.available || discovery.source !== "missing") await acknowledgeCopilotSetup(root);
  return withCopilotRuntimeLock(root, async () => ({
    ...discovery,
    error,
    diagnostic: discovery.error,
    managed: await managedCopilotInstallations(root),
    activeLeases: await activeCopilotLeases(root),
    onboarding: discovery.source === "missing" && !(await copilotSetupAcknowledged(root)),
    pinnedVersion: COPILOT_RUNTIME_VERSION,
    job: await readCopilotJob(root),
  }));
}
