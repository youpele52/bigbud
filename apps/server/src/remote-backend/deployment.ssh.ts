import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { buildSshCommandInvocation, sshClientProcessEnv } from "../ssh/sshCommand.ts";
import { assertSshExecutionTargetReadyAsync } from "../ssh/sshVerification.ts";
import type {
  DeploymentRemoteCommand,
  DeploymentRemoteResult,
  DeploymentRemoteRunner,
} from "./deployment.types.ts";

const MAX_OUTPUT_BYTES = 256 * 1024;
const TRANSPORT_ARGS = [
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
];

/**
 * Spawn one bounded LOCAL process; stdin is fixed text or a streamed local file. `localEnv` is the
 * spawned process's own environment (never a remote command's). Exported for tests.
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

/**
 * Production runner: application-owned `clean-posix` wrapper, strict known-host keys only.
 * `command.env` is the REMOTE command's environment and travels inside the remote command; the
 * local `ssh` client keeps the shared SSH client environment (agent socket, PATH, HOME).
 */
export const runDeploymentSsh: DeploymentRemoteRunner = async (target, command, signal) => {
  await assertSshExecutionTargetReadyAsync(target);
  signal.throwIfAborted();
  const invocation = buildSshCommandInvocation({
    executionTargetId: target,
    shellMode: "clean-posix",
    command: command.command,
    args: command.args,
    ...(command.env ? { env: command.env } : {}),
    transportArgs: TRANSPORT_ARGS,
  });
  return runBoundedProcess(
    invocation.command,
    invocation.args,
    {
      ...(command.stdin ? { stdin: command.stdin } : {}),
      timeoutMs: command.timeoutMs,
      localEnv: sshClientProcessEnv(),
    },
    signal,
  );
};
