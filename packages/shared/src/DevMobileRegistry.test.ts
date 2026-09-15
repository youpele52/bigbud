import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMobileDevRecord,
  createMobileDevRegistry,
  discoverMobileDevUrl,
  publishMobileDevRecord,
  type MobileDevRegistry,
} from "./DevMobileRegistry";
import { MOBILE_DEV_HEALTH_PATH, probeMobileListener } from "./DevMobileRegistry.http";

let root: string;
let registry: MobileDevRegistry;
const servers: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bigbud-mobile-registry-test-"));
  registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await rm(root, { recursive: true, force: true });
});

async function listener(response?: "wrong" | "hang" | "redirect" | "oversized") {
  let nonce = "";
  const server = createServer((req, res) => {
    expect(req.url).toBe(MOBILE_DEV_HEALTH_PATH);
    if (response === "hang") return;
    if (response === "redirect") {
      res.writeHead(302, { Location: "http://example.invalid" });
    }
    res.end(
      response === "oversized"
        ? "x".repeat(2048)
        : JSON.stringify({ nonce: response === "wrong" ? "wrong" : nonce }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const record = createMobileDevRecord(address.port);
  nonce = record.nonce;
  return {
    server,
    record,
    recover: () => {
      response = undefined;
    },
  };
}

async function storeRecord(record: { nonce: string; port: unknown }) {
  await mkdir(registry.directory, { recursive: true });
  await writeFile(path.join(registry.directory, `${record.nonce}.json`), JSON.stringify(record));
}

describe("mobile development registry", () => {
  it("scopes by canonical checkout and numeric requested instance", async () => {
    const alias = path.join(root, "alias");
    await symlink(root, alias, "junction");
    expect(await createMobileDevRegistry(alias, "00", path.join(root, "registry"))).toEqual(
      registry,
    );
    expect(await createMobileDevRegistry(root, "1", path.join(root, "registry"))).not.toEqual(
      registry,
    );
    const other = await mkdtemp(path.join(root, "other-"));
    expect(await createMobileDevRegistry(other, "0", path.join(root, "registry"))).not.toEqual(
      registry,
    );
    await expect(createMobileDevRegistry(root, "invalid")).rejects.toThrow("non-negative integer");
  });

  it("returns null before startup and the lowest live companion after registration", async () => {
    expect(await discoverMobileDevUrl(registry)).toBeNull();
    const first = await listener();
    const second = await listener();
    const removeFirst = await publishMobileDevRecord(registry, first.record);
    await publishMobileDevRecord(registry, second.record);
    await expect
      .poll(() => discoverMobileDevUrl(registry))
      .toBe(`http://127.0.0.1:${Math.min(first.record.port, second.record.port)}`);
    await removeFirst();
    expect(await readdir(registry.directory)).toEqual([`${second.record.nonce}.json`]);
    await expect
      .poll(() => discoverMobileDevUrl(registry))
      .toBe(`http://127.0.0.1:${second.record.port}`);
  });

  it("does not advertise crashed listeners or a replacement listener with another nonce", async () => {
    const { server, record } = await listener();
    await publishMobileDevRecord(registry, record);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await discoverMobileDevUrl(registry)).toBeNull();
    const replacement = createServer((_req, res) =>
      res.end(JSON.stringify({ nonce: "replacement" })),
    );
    servers.push(replacement);
    await new Promise<void>((resolve) => replacement.listen(record.port, "127.0.0.1", resolve));
    expect(await discoverMobileDevUrl(registry)).toBeNull();
  });

  it.each(["wrong", "hang", "redirect", "oversized"] as const)(
    "does not advertise %s health responses",
    async (response) => {
      const { record } = await listener(response);
      await publishMobileDevRecord(registry, record);
      expect(await discoverMobileDevUrl(registry)).toBeNull();
    },
  );

  it("bounds slow probes and ignores malformed records without deleting another owner's files", async () => {
    const { record } = await listener("hang");
    const started = Date.now();
    expect(await probeMobileListener(record, 30)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    await storeRecord({ ...record, port: "http://example.invalid" });
    const corrupt = createMobileDevRecord(1);
    await writeFile(path.join(registry.directory, `${corrupt.nonce}.json`), "{");
    expect(await discoverMobileDevUrl(registry)).toBeNull();
    expect(await readdir(registry.directory)).toHaveLength(2);
  });

  it("discovers a listener that recovers after an initial health timeout without reregistering", async () => {
    const { record, recover } = await listener("hang");
    await publishMobileDevRecord(registry, record);
    expect(await discoverMobileDevUrl(registry)).toBeNull();
    recover();
    expect(await discoverMobileDevUrl(registry)).toBe(`http://127.0.0.1:${record.port}`);
  });
});
