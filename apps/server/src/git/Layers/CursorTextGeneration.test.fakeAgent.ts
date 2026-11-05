/**
 * Fake Cursor `agent --trust acp` for text generation lifecycle tests: a real child process that
 * speaks just enough ACP (NDJSON JSON-RPC) and keeps a grandchild in its process group, standing
 * in for the MCP servers a real agent starts.
 *
 * @module CursorTextGeneration.test.fakeAgent
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type FakeCursorAgentMode = "ok" | "invalid-output" | "hang";

const AGENT_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, pidFile] = process.argv.slice(2);
// Ignores SIGTERM, like Cursor's worker-server can: the release must escalate to SIGKILL.
const grandchild = spawn("sh", ["-c", "trap '' TERM; exec sleep 60"], { stdio: "ignore" });
writeFileSync(pidFile, process.pid + " " + grandchild.pid);

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const results = {
  initialize: { protocolVersion: 1 },
  "session/new": { sessionId: "fake-session" },
  "session/set_mode": {},
  "session/set_config_option": { configOptions: [] },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method !== "session/prompt") {
    send({ id: message.id, result: results[message.method] ?? {} });
    return;
  }
  if (mode === "hang") return;
  const text = mode === "ok" ? JSON.stringify({ title: "Fake title" }) : "not json";
  send({
    method: "session/update",
    params: {
      sessionId: "fake-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
  send({ id: message.id, result: { stopReason: "end_turn" } });
});
`;

export interface FakeCursorAgent {
  /** Use as `providers.cursor.binaryPath`. */
  readonly binaryPath: string;
  /** Reads "<agent pid> <grandchild pid>" once the agent has started. */
  readonly readPids: () => { readonly agentPid: number; readonly grandchildPid: number };
}

export function writeFakeCursorAgent(dir: string, mode: FakeCursorAgentMode): FakeCursorAgent {
  const scriptPath = path.join(dir, "fake-cursor-agent.mjs");
  const pidFile = path.join(dir, "agent.pids");
  const binaryPath = path.join(dir, "agent");
  fs.writeFileSync(scriptPath, AGENT_SOURCE);
  fs.writeFileSync(
    binaryPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" ${mode} "${pidFile}"\n`,
    { mode: 0o755 },
  );
  return {
    binaryPath,
    readPids: () => {
      const [agentPid, grandchildPid] = fs.readFileSync(pidFile, "utf8").split(" ").map(Number);
      return { agentPid: agentPid!, grandchildPid: grandchildPid! };
    },
  };
}
