import { acquireStateDirLock } from "../../../startup/stateDirLock.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";

// Disposable "backend A": holds the real state-directory lock and persists signed thread-tool
// records with the shared issuer, then waits to be SIGKILLed without any cleanup. Disposable key
// material arrives on stdin, never arguments/logs.
let body = "";
for await (const chunk of process.stdin) {
  body += chunk.toString();
  if (Buffer.byteLength(body) > 65536) throw new Error("Synthetic backend input bound.");
}
const input = JSON.parse(body);
const lock = await acquireStateDirLock({ stateDir: input.stateDir, port: 0 });
const records = await V2ThreadRecords.open(
  input.root,
  "enrollments",
  input.privateKey,
  input.publicKey,
);
if (input.marker) {
  const { writeV2OwnerMarker } = await import("./Orchestration.instances.ts");
  const { makeBackendInstance } = await import("../../../startup/backendInstance.ts");
  await writeV2OwnerMarker(
    records,
    makeBackendInstance(lock, input.stateDir),
    input.enrollment.digest,
    input.enrollment.owner.enrollmentNonce,
  );
}
await records.replace(input.key, undefined, input.enrollment);
if (input.receipt)
  await (
    await records.sibling("receipts")
  ).replace(input.receipt.key, undefined, input.receipt.value);
console.log(JSON.stringify({ ready: true, pid: process.pid, nonce: lock.record.nonce }));
setInterval(() => {}, 1 << 30);
