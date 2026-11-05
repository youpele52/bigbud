import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { recordBackendStartupDevelopmentDiagnostics } from "./backendStartupState";
import { createDevelopmentBackendDiagnostics } from "./backendStartupDiagnostics";

/** Retains bounded crash output until the child's close event has drained its streams. */
export function captureBackendStderr(
  stderr: Readable | null,
  generation: number,
  development: boolean,
): () => string {
  let tail = "";
  if (stderr) {
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      tail = `${tail}${chunk}`.slice(-8192);
      if (development)
        recordBackendStartupDevelopmentDiagnostics(
          generation,
          createDevelopmentBackendDiagnostics({ stderrTail: tail }),
        );
    });
  }
  return () => tail;
}

/** Logs stdout/stderr pipe errors of a backend child instead of letting them throw. */
export function logBackendOutputPipeErrors(
  child: Pick<ChildProcess, "stdout" | "stderr">,
  generation: number,
  log: (event: string, detail: string) => void,
  onPipeError: () => void,
): void {
  for (const [stream, event] of [
    [child.stdout, "stdout_error"],
    [child.stderr, "stderr_error"],
  ] as const) {
    stream?.on("error", (error) => {
      log(event, `generation=${generation} error=${error.message}`);
      onPipeError();
    });
  }
}
