import * as ChildProcess from "node:child_process";

const COMMAND_OUTPUT_MAX_CHARS = 256_000;
const SHORT_COMMAND_TIMEOUT_MS = 30_000;

export function runCommand(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs = SHORT_COMMAND_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(command, args, {
      env,
      stdio: "pipe",
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = (stdout + chunk.toString()).slice(-COMMAND_OUTPUT_MAX_CHARS);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-COMMAND_OUTPUT_MAX_CHARS);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
