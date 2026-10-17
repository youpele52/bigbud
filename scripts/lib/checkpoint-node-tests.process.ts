import { spawn } from "node:child_process";
import {
  beginWindowsTreeCleanup,
  type WindowsTreeCleanup,
} from "./checkpoint-node-tests.windows.ts";

export const checkpointNodeCleanupMs = 5000;
export class OwnedNodeHarnessError extends Error {
  readonly code:
    | "NODE_TREE_CLEANUP_UNKNOWN"
    | "NODE_TIMEOUT"
    | "NODE_CANCELLED"
    | "NODE_OUTPUT_LIMIT"
    | "NODE_EXIT"
    | "NODE_SPAWN";
  readonly stdout: string;
  readonly stderr: string;
  constructor(
    code:
      | "NODE_TREE_CLEANUP_UNKNOWN"
      | "NODE_TIMEOUT"
      | "NODE_CANCELLED"
      | "NODE_OUTPUT_LIMIT"
      | "NODE_EXIT"
      | "NODE_SPAWN",
    message: string,
    stdout = "",
    stderr = "",
  ) {
    super(message);
    this.name = "OwnedNodeHarnessError";
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** One executor retains cleanup uncertainty; late exit never authorizes another attempt. */
export function createOwnedNodeExecutor(
  platform: NodeJS.Platform = process.platform,
  dependencies: {
    launch?: typeof spawn;
    windowsCleanup?: typeof beginWindowsTreeCleanup;
  } = {},
) {
  let blocked = false;
  return (
    args: string[],
    options: {
      cwd: string;
      timeoutMs: number;
      maxBuffer: number;
      command?: string;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      inheritOwnerGroup?: boolean;
    },
  ) => {
    if (options.signal?.aborted)
      return Promise.reject(
        new OwnedNodeHarnessError("NODE_CANCELLED", "Checkpoint process cancelled before launch"),
      );
    if (blocked)
      return Promise.reject(
        new OwnedNodeHarnessError(
          "NODE_TREE_CLEANUP_UNKNOWN",
          "Previous Node harness tree cleanup is unknown; new launch refused",
        ),
      );
    const startedAt = performance.now();
    const cancelAt = startedAt + options.timeoutMs;
    const joinAt = cancelAt + checkpointNodeCleanupMs;
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      // POSIX detached:true creates a new session/group, never the Vitest parent's group.
      const child = (dependencies.launch ?? spawn)(options.command ?? "node", args, {
        cwd: options.cwd,
        detached: platform !== "win32" && !options.inheritOwnerGroup,
        windowsHide: true,
        shell: false,
        ...(options.env ? { env: options.env } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let group: number | undefined;
      let reaped = false;
      let spawned = false;
      let signalAttempted = false;
      let settled = false;
      let failure: OwnedNodeHarnessError | undefined;
      let windowsCleanup: WindowsTreeCleanup | undefined;
      let windowsCleanupPending = false;
      let closeCode: number | null | undefined;
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let cancelTimer: ReturnType<typeof setTimeout>;
      let joinTimer: ReturnType<typeof setTimeout>;
      const finish = (code: number | null) => {
        if (settled) return;
        if (windowsCleanupPending) return;
        settled = true;
        clearTimeout(cancelTimer);
        clearTimeout(joinTimer);
        windowsCleanup?.dispose();
        options.signal?.removeEventListener("abort", abort);
        const stdout = Buffer.concat(output, outputBytes).toString("utf8");
        const stderr = Buffer.concat(errors, errorBytes).toString("utf8");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        if (failure)
          reject(new OwnedNodeHarnessError(failure.code, failure.message, stdout, stderr));
        else if (code !== 0)
          reject(
            new OwnedNodeHarnessError(
              "NODE_EXIT",
              `Node exited with code ${code ?? "null"} (${child.signalCode ?? "no signal"})`,
              stdout,
              stderr,
            ),
          );
        else resolve({ stdout, stderr });
      };
      const unknown = (message: string) => {
        blocked = true;
        windowsCleanupPending = false;
        failure = new OwnedNodeHarnessError("NODE_TREE_CLEANUP_UNKNOWN", message);
        finish(null);
      };
      const cancel = (reason: OwnedNodeHarnessError) => {
        if (settled || signalAttempted) return;
        failure = reason;
        signalAttempted = true;
        if (!group || reaped || child.exitCode !== null || child.signalCode !== null) {
          unknown("Cannot terminate Node tree: unreaped child identity is no longer held");
          return;
        }
        if (platform === "win32") {
          windowsCleanupPending = true;
          try {
            windowsCleanup = (dependencies.windowsCleanup ?? beginWindowsTreeCleanup)(
              child,
              () =>
                !reaped &&
                group === child.pid &&
                child.exitCode === null &&
                child.signalCode === null,
              Math.min(joinAt, performance.now() + checkpointNodeCleanupMs),
            );
            void windowsCleanup.result.then(
              (confirmed) => {
                if (settled) return;
                windowsCleanupPending = false;
                if (!confirmed) unknown("Owned Windows taskkill tree cleanup was not confirmed");
                else if (closeCode !== undefined) finish(closeCode);
              },
              () => {
                if (!settled) unknown("Owned Windows taskkill tree cleanup failed");
              },
            );
          } catch {
            unknown("Owned Windows taskkill tree cleanup could not start");
          }
          return;
        }
        try {
          // Exactly one signal to the group created by this spawn, before leader reap.
          // No parent-only fallback and no repeated numeric-PID signaling after exit.
          if (options.inheritOwnerGroup) {
            // Trusted in-process Bun compiler stays inside the outer harness group.
            // Its own deadline uses only the retained handle; never signal the parent's group.
            if (!child.kill("SIGKILL"))
              throw new Error("Compiler handle termination was not confirmed");
          } else process.kill(-group, "SIGKILL");
        } catch (error) {
          unknown(`Owned Node group SIGKILL failed: ${(error as Error).message}`);
        }
      };
      child.once("spawn", () => {
        spawned = true;
        const pid = child.pid;
        if (pid !== undefined && pid > 1 && pid !== process.pid && pid !== process.ppid)
          group = pid;
      });
      child.once("exit", () => {
        reaped = true;
        group = undefined;
      });
      child.once("error", (error) => {
        if (group && !reaped) cancel(new OwnedNodeHarnessError("NODE_SPAWN", error.message));
        else {
          failure = new OwnedNodeHarnessError("NODE_SPAWN", error.message);
          finish(null);
        }
      });
      child.once("close", (code) => {
        closeCode = code;
        finish(code);
      });
      const capture = (chunk: Buffer, stderr: boolean) => {
        if (settled || signalAttempted) return;
        const bytes = stderr ? errorBytes : outputBytes;
        const retained = Buffer.from(chunk.subarray(0, Math.max(0, options.maxBuffer - bytes)));
        if (stderr) {
          errors.push(retained);
          errorBytes += retained.length;
        } else {
          output.push(retained);
          outputBytes += retained.length;
        }
        if (bytes + chunk.length > options.maxBuffer)
          cancel(
            new OwnedNodeHarnessError(
              "NODE_OUTPUT_LIMIT",
              "Node harness exceeded maxBuffer; owned tree cancellation requested",
            ),
          );
      };
      const abort = () => {
        if (!spawned && !reaped) return; // The spawn handler acts on a pending cancellation.
        cancel(
          new OwnedNodeHarnessError(
            "NODE_CANCELLED",
            "Owned checkpoint process cancellation requested after readiness",
          ),
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => capture(chunk, false));
      child.stderr.on("data", (chunk: Buffer) => capture(chunk, true));
      child.stdout.on("error", (error: Error) =>
        cancel(new OwnedNodeHarnessError("NODE_EXIT", `Node stdout failed: ${error.message}`)),
      );
      child.stderr.on("error", (error: Error) =>
        cancel(new OwnedNodeHarnessError("NODE_EXIT", `Node stderr failed: ${error.message}`)),
      );
      cancelTimer = setTimeout(
        () =>
          cancel(
            new OwnedNodeHarnessError(
              "NODE_TIMEOUT",
              `Node harness timed out; owned ${platform === "win32" ? "taskkill tree" : "group SIGKILL"} requested`,
            ),
          ),
        Math.max(0, cancelAt - performance.now()),
      );
      joinTimer = setTimeout(
        () => {
          if (!settled)
            unknown("Owned Node tree did not join before the original shared cleanup deadline");
        },
        Math.max(0, joinAt - performance.now()),
      );
      child.once("spawn", () => {
        if (options.signal?.aborted) abort();
      });
    });
  };
}

export const executeOwnedNode = createOwnedNodeExecutor();
