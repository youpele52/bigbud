// Reuse the existing owned-process executor: a hung parser must not orphan Chromium.
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { executeOwnedNode } from "../lib/checkpoint-node-tests.process.ts";

const directory = join(tmpdir(), "opencode");
await mkdir(directory, { recursive: true });
const owned = await mkdtemp(join(directory, "terminal-production-"));
const payload = join(owned, "vendor-input.json");
const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
let cleanupKnown = true;
try {
  const input = readFileSync(0);
  if (input.byteLength > 10 * 1024 * 1024) throw new Error("vendor input budget exceeded");
  await writeFile(payload, input);
  const { stdout } = await executeOwnedNode(
    ["run", fileURLToPath(new URL("checkpoint.production.mjs", import.meta.url)), payload],
    {
      command: process.execPath,
      cwd: dirname(fileURLToPath(new URL("../../package.json", import.meta.url))),
      timeoutMs: 60_000,
      maxBuffer: 1024 * 1024,
      signal: controller.signal,
    },
  );
  const memory = await executeOwnedNode(
    [
      "run",
      fileURLToPath(new URL("checkpoint.production.mjs", import.meta.url)),
      payload,
      "--memory",
    ],
    {
      command: process.execPath,
      cwd: dirname(fileURLToPath(new URL("../../package.json", import.meta.url))),
      timeoutMs: 60_000,
      maxBuffer: 1024 * 1024,
      signal: controller.signal,
    },
  );
  process.stdout.write(
    JSON.stringify(
      { ...JSON.parse(stdout), productMaximumMemory: JSON.parse(memory.stdout) },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  cleanupKnown = error.code !== "NODE_TREE_CLEANUP_UNKNOWN";
  if (!cleanupKnown) console.error(`Retained owned fixture after uncertain cleanup: ${owned}`);
  console.error(error.stderr || error.message);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
  if (cleanupKnown) await rm(owned, { recursive: true, force: true });
}
