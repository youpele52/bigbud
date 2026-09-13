import { mkdtemp, rm } from "node:fs/promises";
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
import { MOBILE_DEV_HEALTH_PATH } from "./DevMobileRegistry.http";

it("advertises the verified IPv4 listener even when another service later owns IPv6", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-mobile-routing-test-"));
  let nonce = "";
  const mobile = createServer((_req, res) => res.end(JSON.stringify({ nonce })));
  const other = createServer((_req, res) => res.end(JSON.stringify({ nonce: "unrelated-ipv6" })));
  try {
    await new Promise<void>((resolve) => mobile.listen(0, "0.0.0.0", resolve));
    const address = mobile.address();
    if (!address || typeof address === "string") throw new Error("Missing mobile listener");
    const registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
    const record = createMobileDevRecord(address.port);
    nonce = record.nonce;
    await publishMobileDevRecord(registry, record);
    const expectedUrl = `http://127.0.0.1:${address.port}`;
    await expect.poll(() => discoverMobileDevUrl(registry)).toBe(expectedUrl);

    try {
      await new Promise<void>((resolve, reject) => {
        other.once("error", reject);
        other.listen(address.port, "::1", resolve);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EADDRNOTAVAIL", "EAFNOSUPPORT", "EADDRINUSE"].includes(String(error.code))
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    // Discovery intentionally fails closed on transient socket/probe failures.
    // Wait for a verified observation, as Local polling does, then check the
    // returned literal actually reaches the intended listener (not localhost).
    let actualUrl: string | null = null;
    await expect
      .poll(async () => {
        actualUrl = await discoverMobileDevUrl(registry);
        return actualUrl;
      })
      .toBe(expectedUrl);
    expect(await fetch(`${actualUrl}${MOBILE_DEV_HEALTH_PATH}`).then((res) => res.json())).toEqual({
      nonce,
    });
    expect(
      await fetch(`http://[::1]:${address.port}${MOBILE_DEV_HEALTH_PATH}`).then((res) =>
        res.json(),
      ),
    ).toEqual({ nonce: "unrelated-ipv6" });
  } finally {
    mobile.closeAllConnections();
    other.closeAllConnections();
    await Promise.all(
      [mobile, other].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
