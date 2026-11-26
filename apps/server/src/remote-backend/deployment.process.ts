import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

import type { DeploymentRemoteCommand, DeploymentRemoteResult } from "./deployment.types.ts";

const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Spawn one bounded LOCAL process; stdin is fixed text or a streamed local file. `localEnv` is the
 * spawned process's own environment. Deployment tests use it to run their local fake runner;
 * product deployment steps run only through the SSH owner.
 */
export function runBoundedProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: Pick<DeploymentRemoteCommand, "stdin" | "timeoutMs"> & {
    readonly localEnv: NodeJS.ProcessEnv;
  },
  signal: AbortSignal,
): Promise<DeploymentRemoteResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.localEnv,
    });
    let stdout = "",
      stderr = "",
      settled = false;
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(kill, options.timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    const finish = (error?: unknown, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (error) reject(error);
      else if (signal.aborted) reject(signal.reason);
      else resolve({ code: code ?? null, stdout, stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) kill();
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16 * 1024);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code));
    child.stdin.on("error", () => {});
    const input = options.stdin;
    if (!input) child.stdin.end();
    else if ("text" in input) child.stdin.end(input.text);
    else {
      const file = createReadStream(input.path);
      file.once("error", (error) => {
        kill();
        finish(error);
      });
      file.pipe(child.stdin);
    }
  });
}
