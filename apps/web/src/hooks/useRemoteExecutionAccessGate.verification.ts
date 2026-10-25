import { readNativeApi } from "../rpc/nativeApi";
import { getRemoteAgentAccessError } from "./useRemoteExecutionAccessGate.shared";

export async function verifyRemoteExecutionTarget(input: {
  readonly executionTargetId: string;
  readonly cwd?: string;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) throw new Error("Native API not found.");
  const result = await api.server.verifyExecutionTarget(input);
  const error = getRemoteAgentAccessError(result.remoteAgent);
  if (error) throw new Error(error);
}
