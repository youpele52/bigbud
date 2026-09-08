import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { verifyRemoteAgentRuntimeHealth } from "./remoteAgentRuntime.health.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";

export async function verifyRemoteAgentRuntimeAdmission(input: {
  readonly target: string;
  readonly runtime: RemoteAgentRuntime;
  readonly expectedEpoch?: string;
  readonly connect: (target: string, runtime: RemoteAgentRuntime) => RemoteAgentConnection;
}): Promise<string> {
  return verifyRemoteAgentRuntimeHealth(input);
}
