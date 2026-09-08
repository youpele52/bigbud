import {
  isInstalledProcessQuiescing,
  trackInstalledProcessStart,
} from "./installedProcessQuiescence";

export async function resolveBackendStartWhenAllowed(
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (isInstalledProcessQuiescing()) return undefined;
  const environment = await trackInstalledProcessStart(resolveEnvironment);
  return isInstalledProcessQuiescing() ? undefined : environment;
}
