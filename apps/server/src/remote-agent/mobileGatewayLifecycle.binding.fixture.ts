#!/usr/bin/env node
/** Synthetic wire peer for focused tests, never a Rust-base release or production agent. */
import * as fs from "node:fs";
import { join } from "node:path";
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";

const root = process.env.BIGBUD_AGENT_STATE_DIR;
if (!root) throw new Error("Explicit fixture state required");
const hello: RemoteAgentHello = JSON.parse(
  fs.readFileSync(join(root, "gateway-agent-fixture.json"), "utf8"),
);
let input = Buffer.alloc(0);
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (length > 1024 * 1024) throw new Error("fixture input exceeded bound");
    if (input.length < length + 4) return;
    const frame = decodeDelimitedFrame(input.subarray(0, length + 4));
    input = input.subarray(length + 4);
    fs.appendFileSync(
      join(root, "gateway-agent-requests.jsonl"),
      JSON.stringify({
        type: frame.type,
        kind: frame.type === "diagnosticRequest" ? frame.value.kind : null,
      }) + "\n",
    );
    if (frame.type === "clientHello") {
      if (hello.agentEpoch !== "stall")
        process.stdout.write(encodeDelimitedFrame({ type: "agentHello", value: hello }));
    } else if (frame.type === "diagnosticRequest" && frame.value.kind === "readiness") {
      process.stdout.write(
        encodeDelimitedFrame({
          type: "diagnosticResponse",
          value: {
            requestId: frame.value.requestId,
            operationId: frame.value.operationId,
            accepted: true,
            terminal: true,
            message: "agent-ready",
          },
        }),
      );
    } else throw new Error("fixture refuses non-diagnostic work");
  }
});
