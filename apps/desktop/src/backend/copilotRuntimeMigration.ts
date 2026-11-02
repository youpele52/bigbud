import { preserveBundledCopilotRuntime } from "@bigbud/shared/copilotRuntime.bridge";

/** Fixed app-bundle source only; failed pre-update preservation must prevent bundle replacement. */
export async function preservePackagedCopilotRuntime(
  isPackaged: boolean,
  resourcesPath = process.resourcesPath,
): Promise<void> {
  if (!isPackaged) return;
  await preserveBundledCopilotRuntime({ resourcesPath });
}
