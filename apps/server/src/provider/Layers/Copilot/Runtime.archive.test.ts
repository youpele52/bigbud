import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { extractCopilotRuntime } from "./Runtime.archive.ts";
import { runtimeFixture } from "./Runtime.test.helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storage(bytes: Uint8Array) {
  const root = await mkdtemp(Path.join(tmpdir(), "bigbud-copilot-archive-"));
  roots.push(root);
  const archive = Path.join(root, "runtime.tgz");
  await writeFile(archive, bytes);
  return { archive, destination: root };
}

describe("strict Copilot archive extraction", () => {
  it("extracts the complete fixed package and keeps its executable bytes unchanged", async () => {
    const fixture = runtimeFixture();
    await extractCopilotRuntime({ ...(await storage(fixture.bytes)), release: fixture.release });
  });

  it("streams a binary larger than the decompression chunk size", async () => {
    const initial = runtimeFixture();
    const binary = Buffer.alloc(256_000, 97);
    const fixture = runtimeFixture({
      members: initial.members.map((member) =>
        member.name === "package/copilot" ? { name: member.name, bytes: binary } : member,
      ),
    });
    const input = await storage(fixture.bytes);
    await extractCopilotRuntime({ ...input, release: fixture.release });
    expect(await readFile(Path.join(input.destination, "package", "copilot"))).toEqual(binary);
  });

  it.each([
    "../outside",
    "package/../../outside",
    "/outside",
    "package\\outside",
    "package/unexpected",
  ])("rejects unsafe/unexpected member %s", async (name) => {
    const fixture = runtimeFixture({ members: [{ name, bytes: Buffer.from("bad") }] });
    await expect(
      extractCopilotRuntime({ ...(await storage(fixture.bytes)), release: fixture.release }),
    ).rejects.toThrow("Unsafe or unsupported");
  });

  it.each(["1", "2", "3", "4", "5", "6", "x", "g", "L"])(
    "rejects links, devices, and extensions of type %s",
    async (type) => {
      const fixture = runtimeFixture({
        members: [{ name: "package/copilot", bytes: Buffer.from("bad"), type }],
      });
      await expect(
        extractCopilotRuntime({ ...(await storage(fixture.bytes)), release: fixture.release }),
      ).rejects.toThrow("Unsafe or unsupported");
    },
  );

  it("rejects duplicate members", async () => {
    const fixture = runtimeFixture({
      members: [
        { name: "package/copilot", bytes: Buffer.from("first") },
        { name: "package/copilot", bytes: Buffer.from("second") },
      ],
    });
    await expect(
      extractCopilotRuntime({ ...(await storage(fixture.bytes)), release: fixture.release }),
    ).rejects.toThrow("Unsafe or unsupported");
  });

  it.each(["header", "padding", "truncated", "trailing", "missing", "oversized"])(
    "rejects %s corruption",
    async (kind) => {
      const fixture = runtimeFixture();
      let tar = Buffer.from(fixture.tar);
      if (kind === "header") tar[0] = tar[0]! ^ 1;
      if (kind === "padding") tar[512 + fixture.members[0]!.bytes.length] = 1;
      if (kind === "truncated") tar = tar.subarray(0, 520);
      if (kind === "trailing") tar = Buffer.concat([tar, Buffer.from("bad")]);
      const bytes =
        kind === "missing"
          ? runtimeFixture({ members: fixture.members.slice(1) }).bytes
          : gzipSync(tar);
      const release =
        kind === "oversized" ? { ...fixture.release, unpackedBytes: 1 } : fixture.release;
      await expect(extractCopilotRuntime({ ...(await storage(bytes)), release })).rejects.toThrow();
    },
  );
});
