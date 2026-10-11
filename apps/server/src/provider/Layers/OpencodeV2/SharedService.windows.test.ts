import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { V2WindowsInspector } from "./SharedService.windows.ts";

/** Simulated protocol peer only; these tests do not claim Windows ACL/process coverage. */
async function peer(hello = '"OK\\t1"') {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2 probe space "));
  const binary = path.join(root, "probe");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const readline = require("node:readline");
let count = 0;
readline.createInterface({input: process.stdin}).on("line", line => {
  if (line === "HELLO\\t1") { process.stdout.write(${hello} + "\\n"); return; }
  if (line === "SILENT") return;
  if (line === "OVERSIZE") { process.stdout.write("x".repeat(1048578)); return; }
  if (line === "MISSING") { process.stdout.write("ERR\\tmissing\\n"); return; }
  const value = "OK\\t" + ++count + "\\n";
  process.stdout.write(value.slice(0, 2)); setImmediate(() => process.stdout.write(value.slice(2)));
});
`,
    { mode: 0o700 },
  );
  const resolve = vi.fn(() => binary);
  const inspector = new V2WindowsInspector(resolve);
  return {
    inspector,
    resolve,
    async close() {
      inspector.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.skipIf(process.platform === "win32")(
  "keeps one bounded serial peer across fences and handles partial replies",
  async () => {
    const fixture = await peer();
    try {
      const pending = Array.from({ length: 32 }, () => fixture.inspector.request("READ\t00"));
      await expect(fixture.inspector.request("READ\t00")).rejects.toThrow("capacity");
      expect(await Promise.all(pending)).toEqual(
        Array.from({ length: 32 }, (_, i) => [String(i + 1)]),
      );
      expect(fixture.resolve).toHaveBeenCalledTimes(1);
      await expect(fixture.inspector.request("MISSING")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fixture.inspector.request("OVERSIZE")).rejects.toThrow("unavailable");
    } finally {
      await fixture.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "fails a stalled helper within its deadline and permits a fresh read-only connection",
  async () => {
    const fixture = await peer();
    try {
      await expect(fixture.inspector.request("SILENT")).rejects.toThrow("unavailable");
      expect(await fixture.inspector.request("READ\t00")).toEqual(["1"]);
      expect(fixture.resolve).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "rejects an old/incompatible helper before any metadata request",
  async () => {
    const fixture = await peer('"OK\\t0"');
    try {
      await expect(fixture.inspector.request("READ\t00")).rejects.toThrow("incompatible");
    } finally {
      await fixture.close();
    }
  },
);
