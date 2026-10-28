import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CUA_DRIVER_REQUIRED_TOOLS } from "@bigbud/shared/cua-driver/policy";
import { expect } from "vitest";

/** A stand-in `cua-driver mcp` that logs every tools/call and never answers `hangTool`. */
const fakeDriverSource = (hangTool: string) => `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const log = join(dirname(process.argv[1]), "calls.log");
const tools = ${JSON.stringify(CUA_DRIVER_REQUIRED_TOOLS.map((name) => ({ name })))};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\n"); end !== -1; end = buffer.indexOf("\\n")) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize") reply({});
    if (message.method === "tools/list") reply({ tools });
    if (message.method === "tools/call") {
      appendFileSync(log, message.params.name + "\\n");
      if (message.params.name !== ${JSON.stringify(hangTool)}) reply({ content: [{ type: "text", text: "ok" }] });
    }
  }
});
`;

/** Points `BIGBUD_CUA_DRIVER_PATH` at a fake stdio driver; `restore` undoes it. */
export function installFakeCuaDriver(hangTool: string) {
  const savedEnv = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "cua-fake-"));
  const script = join(dir, "cua-driver.cjs");
  writeFileSync(script, fakeDriverSource(hangTool));
  chmodSync(script, 0o755);
  process.env.BIGBUD_CUA_DRIVER_PATH = script;
  delete process.env.BIGBUD_CUA_ENDPOINT;
  delete process.env.BIGBUD_CUA_DRIVER_SOCKET;
  const calls = (): string[] => {
    try {
      return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    dir,
    calls,
    waitForCall: async (name: string) => {
      for (let attempt = 0; attempt < 200 && !calls().includes(name); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(calls()).toContain(name);
    },
    restore: () => {
      process.env = { ...savedEnv };
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
