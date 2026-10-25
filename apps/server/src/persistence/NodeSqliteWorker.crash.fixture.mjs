/* oxlint-disable unicorn/require-post-message-target-origin -- worker_threads ports have no origin */
// Test-only worker that stands in for NodeSqliteWorker to exercise bridge failure handling.
import { parentPort, workerData } from "node:worker_threads";

const behaviour = workerData.filename;
if (behaviour === "open-failed") {
  parentPort.postMessage({ kind: "open-failed", error: { message: "cannot open" } });
  parentPort.close();
} else if (behaviour === "exit-before-ready") {
  process.exit(4);
} else if (behaviour === "never-ready") {
  // Keeps the thread alive without ever reporting `ready`, like a stuck open.
  setInterval(() => {}, 1_000);
} else if (behaviour === "ignore-close") {
  // Answers statements but never acknowledges `close`, so only terminate() ends it.
  parentPort.on("message", (request) => {
    if (request.kind === "close") return;
    parentPort.postMessage({ kind: "result", id: request.id, ok: true, rows: [] });
  });
  parentPort.postMessage({ kind: "ready" });
} else {
  parentPort.on("message", (request) => {
    if (request.kind === "close") {
      parentPort.postMessage({ kind: "result", id: request.id, ok: true, rows: [] });
      parentPort.close();
      return;
    }
    if (request.sql === "CRASH")
      setTimeout(() => {
        throw new Error("worker boom");
      }, 20);
    else if (request.sql === "EXIT") setTimeout(() => process.exit(7), 20);
    else parentPort.postMessage({ kind: "result", id: request.id, ok: true, rows: [{ ok: 1 }] });
  });
  parentPort.postMessage({ kind: "ready" });
}
