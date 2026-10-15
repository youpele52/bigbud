import { V2ThreadRecords } from "./Orchestration.records.ts";
import { assertV2PreviousHistoryRetired } from "./Orchestration.enrollment.recovery.ts";

// Independent source-only process. Private keys are disposable fixture material received on
// stdin, never arguments/logs; this reader has no native client or detach capability.
let body = "";
for await (const chunk of process.stdin) {
  body += chunk.toString();
  if (Buffer.byteLength(body) > 32768) throw new Error("Synthetic reader input bound.");
}
const input = JSON.parse(body),
  records = await V2ThreadRecords.open(
    input.root,
    "enrollments",
    input.privateKey,
    input.publicKey,
  );
try {
  await assertV2PreviousHistoryRetired(records, input.scope);
  console.log(JSON.stringify({ state: "settled", nativeCalls: 0 }));
} catch {
  console.log(JSON.stringify({ state: "blocked", nativeCalls: 0 }));
}
