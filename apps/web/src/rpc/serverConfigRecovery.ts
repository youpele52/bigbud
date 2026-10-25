import { retryServerConfigSync } from "./serverConfigReadiness";
import { getWsRpcClient } from "./wsRpcClient";

let reconnectOperation: Promise<void> | null = null;

/** Coordinates an explicit physical retry with any config owner that stopped permanently. */
export function reconnectServerConfig(): Promise<void> {
  if (reconnectOperation) return reconnectOperation;
  const operation = Promise.resolve()
    .then(() => getWsRpcClient().reconnect())
    .then(() => retryServerConfigSync({ onlyIfStopped: true }))
    .catch(() => {
      throw new Error("Unable to reconnect to the bigbud server.");
    })
    .finally(() => {
      if (reconnectOperation === operation) reconnectOperation = null;
    });
  reconnectOperation = operation;
  return operation;
}
