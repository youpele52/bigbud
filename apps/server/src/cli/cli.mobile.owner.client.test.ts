import { afterEach, expect, it } from "vitest";
import * as http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { sendMobileOwnerRequest } from "./cli.mobile.owner.client.ts";
import {
  MOBILE_CONSENT_CONFIRMATION,
  MobileOwnerConsentResult,
  MobileOwnerRepairResult,
  MobileOwnerStatus,
} from "../remote-backend/mobileOwnerActivation.protocol.ts";
import {
  makeOwnerActivationFixture,
  ownerAuthority,
} from "../remote-backend/mobileOwnerActivation.test.helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function socket(handler: http.RequestListener) {
  const directory = await mkdtemp("/tmp/bb-mobile-act-");
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
/** UDS bridge to the real authenticated route handler. */
async function bridged() {
  const app = await makeOwnerActivationFixture();
  cleanups.push(app.dispose);
  return socket((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.once("end", () => {
      void app
        .handler(
          new Request(`http://owner.invalid${req.url}`, {
            method: "POST",
            headers: Object.fromEntries(
              Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
            ) as Record<string, string>,
            body: Buffer.concat(parts).toString(),
          }),
        )
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        });
    });
  });
}

it("reaches the real route: status decodes, stale grant decodes as a fixed refusal", async () => {
  const credentials = await bridged();
  const status = await sendMobileOwnerRequest(
    { action: "status", authorityId: ownerAuthority },
    MobileOwnerStatus,
    credentials,
  );
  expect(status.ok && status.value.consent).toEqual({ state: "disabled", revision: 2 });
  const grant = {
    action: "consent-enable" as const,
    authorityId: ownerAuthority,
    confirmation: MOBILE_CONSENT_CONFIRMATION as typeof MOBILE_CONSENT_CONFIRMATION,
    expectedRevision: 1,
  };
  expect(await sendMobileOwnerRequest(grant, MobileOwnerConsentResult, credentials)).toEqual({
    ok: false,
    refused: "stale-revision",
  });
  expect(
    await sendMobileOwnerRequest(
      { ...grant, expectedRevision: 2 },
      MobileOwnerConsentResult,
      credentials,
    ),
  ).toEqual({ ok: true, value: { enabled: true, revision: 3, changed: true } });
});

it("refuses an invalid request before sending, server prose, redirects and oversize bodies", async () => {
  let requests = 0;
  const replies: Array<(res: http.ServerResponse) => void> = [
    (res) => res.writeHead(503).end("PRIVATE_OWNER_TOKEN"),
    (res) => res.writeHead(302, { location: "https://foreign.invalid/" }).end(),
    (res) => res.writeHead(200).end("x".repeat(20 * 1024)),
  ];
  const credentials = await socket((_req, res) => replies[requests++]!(res));
  await expect(
    sendMobileOwnerRequest(
      { action: "status", authorityId: "not-an-authority" } as never,
      MobileOwnerStatus,
      credentials,
    ),
  ).rejects.toThrow("Owner mobile control is unavailable.");
  expect(requests).toBe(0);
  for (let index = 0; index < replies.length; index++) {
    const error = await sendMobileOwnerRequest(
      { action: "status", authorityId: ownerAuthority },
      MobileOwnerStatus,
      credentials,
    ).catch((cause: unknown) => cause);
    expect(String(error)).toBe("Error: Owner mobile control is unavailable.");
  }
  expect(requests).toBe(3);
});

it("repair through the real route refuses a non-owner authority and is off without a controller", async () => {
  const credentials = await bridged();
  expect(
    await sendMobileOwnerRequest(
      { action: "repair", authorityId: "b".repeat(32) },
      MobileOwnerRepairResult,
      credentials,
    ),
  ).toEqual({ ok: false, refused: "authority-mismatch" });
  expect(
    await sendMobileOwnerRequest(
      { action: "repair", authorityId: ownerAuthority },
      MobileOwnerRepairResult,
      credentials,
    ),
  ).toEqual({ ok: false, refused: "unavailable" });
  const wrong = { ...credentials, token: "someone-else" };
  await expect(
    sendMobileOwnerRequest(
      { action: "repair", authorityId: ownerAuthority },
      MobileOwnerRepairResult,
      wrong,
    ),
  ).rejects.toThrow("Owner mobile control is unavailable.");
});
