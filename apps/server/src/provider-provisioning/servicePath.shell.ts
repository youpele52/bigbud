/**
 * Bounded, non-interactive login-shell environment capture for service PATH discovery.
 *
 * Unlike the desktop/server `fixPath` reader (`-ilc`, unbounded output), this runs `$SHELL -lc`
 * with stdin closed, in its own session (no controlling TTY), with a hard timeout and an output
 * cap. The capture command and marker parsing are reused from `@bigbud/shared/shell`.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { buildEnvironmentCaptureCommand, extractEnvironmentValue } from "@bigbud/shared/shell";
import * as Effect from "effect/Effect";

export const SHELL_CAPTURE_TIMEOUT_MS = 3_000;
export const SHELL_CAPTURE_MAX_OUTPUT_BYTES = 64 * 1024;

export type LoginShellCapture =
  | {
      readonly status: "captured";
      readonly shell: string;
      readonly environment: Partial<Record<string, string>>;
    }
  | { readonly status: "timeout"; readonly shell: string }
  | { readonly status: "oversize"; readonly shell: string }
  | { readonly status: "failed"; readonly shell: string; readonly detail: string };

export interface LoginShellCaptureInput {
  readonly shell: string;
  readonly names: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Detached children lead their own process group; kill profile-spawned helpers too.
    if (child.pid !== undefined && process.platform !== "win32")
      process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function parseEnvironment(
  output: string,
  names: ReadonlyArray<string>,
): Partial<Record<string, string>> {
  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** Runs `<shell> -lc <capture>` once; never throws, always settles within the timeout. */
export const captureLoginShellEnvironment = Effect.fn("captureLoginShellEnvironment")(function* (
  input: LoginShellCaptureInput,
) {
  const timeoutMs = input.timeoutMs ?? SHELL_CAPTURE_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? SHELL_CAPTURE_MAX_OUTPUT_BYTES;
  const command = buildEnvironmentCaptureCommand(input.names);
  const { shell } = input;

  return yield* Effect.callback<LoginShellCapture>((resume) => {
    let settled = false;
    let child: ChildProcess;
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: LoginShellCapture) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(Effect.succeed(result));
    };

    try {
      child = spawn(shell, ["-lc", command], {
        // TERM=dumb discourages prompt/terminal setup in profiles; stdin closed, stderr dropped.
        env: { ...input.env, TERM: "dumb" },
        stdio: ["ignore", "pipe", "ignore"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (cause) {
      finish({ status: "failed", shell, detail: String(cause) });
      return;
    }

    timer = setTimeout(() => {
      killTree(child);
      finish({ status: "timeout", shell });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        killTree(child);
        finish({ status: "oversize", shell });
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (cause) => finish({ status: "failed", shell, detail: cause.message }));
    child.once("close", (code, signal) => {
      const output = Buffer.concat(chunks).toString("utf8");
      const environment = parseEnvironment(output, input.names);
      // A profile may exit non-zero after printing the markers; markers decide success.
      if (Object.keys(environment).length > 0 || code === 0) {
        finish({ status: "captured", shell, environment });
        return;
      }
      finish({
        status: "failed",
        shell,
        detail: signal ? `terminated by ${signal}` : `exited with code ${String(code)}`,
      });
    });

    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
    });
  });
});
