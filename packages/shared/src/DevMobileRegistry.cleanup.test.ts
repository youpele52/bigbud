import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  createMobileDevRecord,
  createMobileDevRegistry,
  discoverMobileDevUrl,
  publishMobileDevRecord,
} from "./DevMobileRegistry";

it("retires more than 256 crashed records and abandoned writes while preserving live owners", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-mobile-cleanup-test-"));
  const registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
  const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(exited.status).toBe(0);
  let nonce = "";
  const server = createServer((_req, res) => res.end(JSON.stringify({ nonce })));
  try {
    await mkdir(registry.directory, { recursive: true });
    for (let index = 0; index < 300; index++) {
      const dead = { ...createMobileDevRecord(1), ownerPid: exited.pid };
      await writeFile(path.join(registry.directory, `${dead.nonce}.json`), JSON.stringify(dead));
    }
    const abandoned = `${createMobileDevRecord(1).nonce}.json.${exited.pid}.tmp`;
    await writeFile(path.join(registry.directory, abandoned), "{");
    const pending = `${createMobileDevRecord(1).nonce}.json.${process.pid}.tmp`;
    await writeFile(path.join(registry.directory, pending), "{");

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const healthy = createMobileDevRecord(address.port);
    nonce = healthy.nonce;
    await publishMobileDevRecord(registry, healthy);
    const mismatched = createMobileDevRecord(address.port);
    await publishMobileDevRecord(registry, mismatched);

    expect(await discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${address.port}`);
    expect((await readdir(registry.directory)).toSorted()).toEqual(
      [pending, `${healthy.nonce}.json`, `${mismatched.nonce}.json`].toSorted(),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("uses a per-user default temporary directory", async () => {
  const registry = await createMobileDevRegistry(tmpdir());
  expect(path.basename(path.dirname(registry.directory))).toMatch(
    /^bigbud-mobile-dev-[a-f0-9]{32}$/,
  );
  expect(path.dirname(path.dirname(registry.directory))).toBe(tmpdir());
});
