import type { PiRpcProcess } from "./RpcProcess.types.ts";

/** Keep queue append/acknowledgement pairs ordered; abort and state queries remain unblocked. */
export function serializePiPromptRequests(
  request: PiRpcProcess["request"],
): PiRpcProcess["request"] {
  let pending = Promise.resolve();
  return <T>(command: Parameters<PiRpcProcess["request"]>[0], timeoutMs?: number) => {
    if (command.type !== "prompt" && command.type !== "steer" && command.type !== "follow_up") {
      return request<T>(command, timeoutMs);
    }
    const result = pending.then(() => request<T>(command, timeoutMs));
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
