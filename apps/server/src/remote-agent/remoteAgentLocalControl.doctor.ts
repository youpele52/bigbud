import { classifyRemoteAgentFailure } from "./remoteAgentFailure.classify.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";
import { probeRemoteAgentPlatform } from "./remoteAgentPlatform.ts";
import { remoteAgentReadOnlyDiagnostics } from "./remoteAgentReadOnlyDiagnostics.ts";

/** A second SSH connection can lose trust even after the platform probe succeeded. */
export async function readRemoteAgentDoctor(
  target: string,
  platform: (target: string) => Promise<unknown> = probeRemoteAgentPlatform,
  registry: (target: string) => Promise<unknown> = remoteAgentReadOnlyDiagnostics,
) {
  const platformResult = await platform(target);
  let agent: unknown;
  try {
    agent = await registry(target);
  } catch (cause) {
    if (classifyRemoteAgentFailure(cause)?.kind === "ssh-host-trust") throw cause;
    agent = { status: "unreadable", message: remoteAgentFailureDetail(cause) };
  }
  return { platform: platformResult, agent };
}
