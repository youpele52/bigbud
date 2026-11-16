import { ChildProcess } from "node:child_process";
import { processStartToken } from "@bigbud/shared/processStartToken";
import type {
  MobileGatewayAttempt,
  MobileGatewayCompletionEvidence,
} from "./mobileGatewayLifecycle.schema.ts";

/** Original JS handle only; no PID/JSON input is accepted as a captured launch. */
export function captureMobileGatewayChild(child: ChildProcess, ownerPid: number) {
  if (!(child instanceof ChildProcess) || child.pid === ownerPid)
    throw new Error("Gateway child requires the original process handle returned by launch.");
  const pid = child.pid;
  let exited = child.exitCode !== null || child.signalCode !== null;
  let spawned = pid !== undefined;
  let failedBeforePid = false,
    closed = false;
  let identity: MobileGatewayAttempt["child"];
  child.once("spawn", () => {
    spawned = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    if (!spawned && pid === undefined && child.pid === undefined) failedBeforePid = true;
  });
  child.once("close", () => {
    closed = true;
  });
  const observe = (): MobileGatewayCompletionEvidence | undefined => {
    if (child.pid !== pid) return undefined;
    if (exited && Number.isSafeInteger(pid) && pid !== undefined && pid > 0)
      return { kind: "original-handle-exit", pid };
    if (failedBeforePid && closed && !spawned && pid === undefined)
      return { kind: "original-handle-spawn-failed" };
    return undefined;
  };
  return {
    process: child,
    observe,
    get identity() {
      return identity;
    },
    probeIdentity: () => {
      if (!pid || exited) return undefined;
      const startedAt = processStartToken(pid);
      if (!startedAt || exited || child.exitCode !== null || child.signalCode !== null)
        return undefined;
      identity = Object.freeze({ pid, startedAt });
      return identity;
    },
  };
}
export type CapturedMobileGatewayChild = ReturnType<typeof captureMobileGatewayChild>;
