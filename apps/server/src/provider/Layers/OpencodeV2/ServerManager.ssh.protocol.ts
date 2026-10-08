import type { ChildProcess } from "node:child_process";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { validateOwnedEndpoint } from "./Compatibility.ts";

/** Only the fixed bootstrap can attest its exact native child exit; SSH/tunnel loss is not proof. */
export function observeV2SshBootstrap(child: ChildProcess, nonce: string) {
  const listeners = new Set<() => void>();
  let exited = false,
    readyPid: number | undefined,
    bytes = Buffer.alloc(0),
    packets = 0;
  let accept!: (value: { url: string; pid: number }) => void, fail!: (error: Error) => void;
  const readiness = new Promise<{ url: string; pid: number }>((resolve, reject) => {
    accept = resolve;
    fail = reject;
  });
  const reject = () => fail(new Error("V2 protected SSH ownership response rejected."));
  child.once("error", reject);
  child.once("exit", () => {
    if (!readyPid) reject();
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 16384) {
      reject();
      child.stdout!.removeAllListeners("data");
      child.stdout!.resume();
      return;
    }
    for (let end; (end = bytes.indexOf(10)) >= 0; ) {
      const packet = bytes.subarray(0, end);
      bytes = bytes.subarray(end + 1);
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packet));
        if (++packets > 2 || value.nonce !== nonce) throw new Error("lease nonce rejected");
        if (!readyPid) {
          if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error("pid rejected");
          const url = validateOwnedEndpoint(value.url);
          readyPid = value.pid;
          accept({ url, pid: value.pid });
        } else if (
          value.type === "native-exited" &&
          value.pid === readyPid &&
          (Number.isInteger(value.code) || typeof value.signal === "string")
        ) {
          exited = true;
          for (const listener of listeners) {
            try {
              listener();
            } catch {
              /* One owner cannot suppress sibling exit proof. */
            }
          }
        } else throw new Error("exit proof rejected");
      } catch {
        reject();
      }
    }
  });
  return {
    ready: runWithAbortableDeadline({
      operation: "V2 SSH readiness",
      timeoutMs: 15000,
      run: () => readiness,
    }),
    hasExited: () => exited,
    onExit: (listener: () => void) => {
      listeners.add(listener);
      if (exited) listener();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
