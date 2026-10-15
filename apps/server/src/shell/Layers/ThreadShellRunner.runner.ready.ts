import { buildReadyMarker, buildReadyScript } from "./ThreadShellRunner.capture";
import { type HiddenShellSession } from "./ThreadShellRunner.runner.types";

/**
 * Prime a freshly spawned hidden shell and wait for its ready marker.
 *
 * Bounded by `timeoutMs`: a shell whose startup files block (or never print the
 * marker) rejects instead of hanging the caller and the thread lock it holds. The
 * caller owns the process and must kill it when this rejects.
 */
export function waitForShellReady(session: HiddenShellSession, timeoutMs: number): Promise<void> {
  const readyMarker = buildReadyMarker();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (session.activeCapture?.kind === "ready" && session.activeCapture.marker === readyMarker) {
        session.activeCapture.reject(
          new Error(`Hidden shell did not become ready within ${timeoutMs}ms.`),
        );
      }
    }, timeoutMs);

    session.activeCapture = {
      kind: "ready",
      marker: readyMarker,
      buffer: "",
      resolve: () => {
        clearTimeout(timeout);
        session.activeCapture = null;
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        session.activeCapture = null;
        reject(error);
      },
    };
    session.process.write(`${buildReadyScript(readyMarker)}\r`);
  });
}
