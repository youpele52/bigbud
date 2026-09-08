import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { releaseRemoteAgentPin } from "./remoteAgentInstall.registry.transitions.ts";
import { pruneRemoteAgentHistory } from "./remoteAgentInstall.registry.admission.ts";

/** Only a coherently committed admission with a persisted local binding may release its attempt pin. */
export async function finishRemoteAgentAdmission(
  control: RemoteAgentControl,
  connectionId: string,
  runtime: RemoteAgentRuntime,
) {
  await control.registry.update((current) =>
    releaseRemoteAgentPin(current, `activation:${connectionId}:${runtime.generation}`),
  );
  const state = await control.registry.update((current) => pruneRemoteAgentHistory(current));
  return { connectionId, state };
}
