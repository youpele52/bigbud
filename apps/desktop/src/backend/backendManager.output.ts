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
