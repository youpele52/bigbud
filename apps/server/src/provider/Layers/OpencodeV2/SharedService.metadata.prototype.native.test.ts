import { execFile } from "node:child_process";
import { copyFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { closeOwnedChild } from "./ServerManager.child.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
const version = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION;
const probe = process.env.BIGBUD_WINDOWS_METADATA_PROBE;
const required = process.env.BIGBUD_WINDOWS_METADATA_REQUIRED === "1";
if (required && (process.platform !== "win32" || !binary || !version || !probe))
  throw new Error("Required Windows metadata prototype fixture unavailable.");
const execute = promisify(execFile);

async function query(pid: number, file?: string) {
  const { stdout } = await execute(probe!, [String(pid), ...(file ? [file] : [])], {
    timeout: 20_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    shell: false,
  });
  return stdout.trim().split("\t");
}

async function observation(pid: number) {
  const fields = await query(pid);
  expect(fields).toHaveLength(5);
  expect(fields[0]).toBe("OBSERVED");
  expect(fields[1]).toMatch(/^[0-9a-f]{16}$/);
  expect(fields[2]).toMatch(/^(?:[0-9a-f]{2})+$/);
  for (const identity of fields.slice(3)) expect(identity).toMatch(/^[0-9a-f]{16}:[0-9a-f]{32}$/);
  return {
    birth: fields[1],
    path: Buffer.from(fields[2]!, "hex").toString("utf8"),
    identity: fields[3],
  };
}

const native = it.skipIf(!probe || !binary || !version || process.platform !== "win32");
native(
  "class47 observes the official native DB through an independent metadata-only file handle",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!, undefined, "native state");
    try {
      // Known only because this test owns the fixture: never guessed by the prototype discovery path.
      const db = path.join(fixture.profile, "data", "opencode", "native state");
      const result = await query(fixture.child.pid!, db);
      expect(result).toHaveLength(3);
      expect(result.slice(0, 2)).toEqual(["MEMBER", "1"]);
      expect(result[2]).toMatch(/^[0-9a-f]{16}:[0-9a-f]{32}$/);
    } finally {
      await fixture.close();
    }
  },
  120_000,
);

native(
  "mapped SHM yields extensionless physical identity stable across a fixture-owned native restart",
  async () => {
    const fixture = await sharedServiceNativeFixture(binary!, undefined, "native state");
    try {
      const config = await readFile(fixture.configFile);
      const before = await observation(fixture.child.pid!);
      expect(path.basename(before.path)).toBe("native state");
      await fixture.restart();
      const after = await observation(fixture.child.pid!);
      expect(after.identity).toBe(before.identity);
      expect(after.birth).not.toBe(before.birth);
      expect(await readFile(fixture.configFile)).toEqual(config);
    } finally {
      await fixture.close();
    }
  },
  120_000,
);

native(
  "distinct native DBs and byte-identical same-path replacement have different physical IDs",
  async () => {
    const first = await sharedServiceNativeFixture(binary!, undefined, "native state");
    try {
      const before = await observation(first.child.pid!);
      const second = await sharedServiceNativeFixture(binary!, undefined, "native state");
      try {
        expect((await observation(second.child.pid!)).identity).not.toBe(before.identity);
      } finally {
        await second.close();
      }
      // Stop only our fixture; copy only its synthetic DB. Probe itself never reads DB contents.
      await closeOwnedChild(first.child);
      await rename(before.path, `${before.path}.retained`);
      await copyFile(`${before.path}.retained`, before.path);
      await first.restart();
      expect((await observation(first.child.pid!)).identity).not.toBe(before.identity);
    } finally {
      await first.close();
    }
  },
  120_000,
);
