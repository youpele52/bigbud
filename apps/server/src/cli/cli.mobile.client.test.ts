import { afterEach, expect, it } from "vitest";
import * as http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { sendMobileOwnerPairingRequest } from "./cli.mobile.client.ts";
import { MOBILE_OWNER_PAIRING_PATH } from "../remote-backend/mobileOwnerPairing.protocol.ts";
import {
  makeOwnerPairingFixture,
  ownerInput,
} from "../remote-backend/mobileOwnerPairing.test.helpers.ts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function fixture(handler: http.RequestListener) {
  const directory = await mkdtemp("/tmp/bb-mobile-owner-");
  const socketPath = join(directory, "owner.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, token: "private-owner-fixture" };
}
const pairing = {
  pairingId: "fixture-pair",
  scope: ownerInput.scope,
  expiresAt: "2099-01-01T00:00:00Z",
  secret: "fixture-secret",
  pairUrl:
    "https://fixture.ts.net/mobile/pair/fixture-pair?backend=https%3A%2F%2Ffixture.ts.net#secret=fixture-secret",
};
it("private UDS client reaches the real authenticated router and file-backed pairing service", async () => {
  const app = makeOwnerPairingFixture({ realMobile: true });
  cleanups.push(app.dispose);
  let seen = 0;
  const credentials = await fixture((req, res) => {
    expect(req.url).toBe(MOBILE_OWNER_PAIRING_PATH);
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer private-owner-fixture");
    expect(req.headers["x-bigbud-client-rpc-revision"]).toBe("1");
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.once("end", () => {
      seen++;
      void app
        .handler(
          new Request(`http://owner.invalid${req.url}`, {
            method: "POST",
            headers: {
              authorization: req.headers.authorization!,
              "x-bigbud-client-rpc-revision": "1",
              "content-type": "application/json",
            },
            body: Buffer.concat(parts).toString(),
          }),
        )
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        });
    });
  });
  const value = await sendMobileOwnerPairingRequest(ownerInput, credentials);
  expect(value.scope).toBe("approve-only");
  expect(new URL(value.pairUrl).origin).toBe(ownerInput.backendOrigin);
  expect(value.pairUrl).not.toContain(credentials.token);
  expect(seen).toBe(1);
});
it("uses one absolute deadline for held headers and a partial response body", async () => {
  for (const partial of [false, true]) {
    const credentials = await fixture((_req, res) => {
      if (partial) {
        res.writeHead(200);
        res.write("{");
      }
    });
    const start = Date.now();
    await expect(
      sendMobileOwnerPairingRequest(ownerInput, credentials, { deadlineMs: 50 }),
    ).rejects.toThrow("Owner mobile pairing is unavailable.");
    expect(Date.now() - start).toBeLessThan(1000);
  }
});
it("bounds incremental response bytes and refuses redirects without a second request", async () => {
  let requests = 0;
  for (const status of [200, 302]) {
    const credentials = await fixture((_req, res) => {
      requests++;
      if (status === 302)
        res.writeHead(302, { location: "https://foreign.invalid/?token=PRIVATE" }).end();
      else {
        res.writeHead(200);
        res.write("x".repeat(8192));
        res.end("x".repeat(8193));
      }
    });
    await expect(sendMobileOwnerPairingRequest(ownerInput, credentials)).rejects.toThrow(
      "Owner mobile pairing is unavailable.",
    );
  }
  expect(requests).toBe(2);
});
it("keeps server errors and private credential values out of failures", async () => {
  const credentials = await fixture((_req, res) => res.writeHead(503).end("PRIVATE_OWNER_TOKEN"));
  const error = await sendMobileOwnerPairingRequest(ownerInput, credentials).catch(
    (cause: unknown) => cause,
  );
  expect(String(error)).toBe("Error: Owner mobile pairing is unavailable.");
  expect(String(error)).not.toContain(credentials.token);
});
it("honors caller abort and validates successful response scope/expiry/link before returning", async () => {
  let requests = 0;
  const credentials = await fixture((_req, res) => {
    requests++;
    res.end(JSON.stringify({ ...pairing, expiresAt: "invalid" }));
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    sendMobileOwnerPairingRequest(ownerInput, credentials, { signal: controller.signal }),
  ).rejects.toThrow("unavailable");
  expect(requests).toBe(0);
  await expect(sendMobileOwnerPairingRequest(ownerInput, credentials)).rejects.toThrow(
    "unavailable",
  );
  expect(requests).toBe(1);
});

it("uses one decoded request snapshot despite caller mutation during the response", async () => {
  let release!: () => void;
  let observed!: () => void;
  const received = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const credentials = await fixture((_req, res) => {
    release = () => res.end(JSON.stringify(pairing));
    observed();
  });
  const mutable = { ...ownerInput };
  const pending = sendMobileOwnerPairingRequest(mutable, credentials);
  await Promise.race([received, pending]);
  mutable.backendOrigin = "https://different.invalid";
  release();
  await expect(pending).resolves.toEqual(pairing);
});
