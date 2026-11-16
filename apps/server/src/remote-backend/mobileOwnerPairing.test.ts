import { decodeMobileOwnerPairingResult } from "./mobileOwnerPairing.protocol.ts";
import { expect, it } from "vitest";
import {
  makeOwnerPairingFixture,
  ownerHeaders,
  ownerInput,
} from "./mobileOwnerPairing.test.helpers.ts";
import { MOBILE_OWNER_PAIRING_PATH } from "./mobileOwnerPairing.protocol.ts";
function request(
  body: unknown = ownerInput,
  headers: Record<string, string> = ownerHeaders,
  suffix = "",
) {
  return new Request(`http://owner.invalid${MOBILE_OWNER_PAIRING_PATH}${suffix}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
it("authenticates owner credentials and compatible revision before issuing or reading body", async () => {
  const app = makeOwnerPairingFixture();
  try {
    expect((await app.handler(request(ownerInput, {}))).status).toBe(401);
    expect(
      (await app.handler(request(ownerInput, { authorization: ownerHeaders.authorization })))
        .status,
    ).toBe(426);
    expect(app.issued()).toBe(0);
  } finally {
    await app.dispose();
  }
});
it("requires remote config, explicit application consent and an actual ready lifecycle producer", async () => {
  for (const options of [
    { remote: false },
    { enabledConfig: false },
    { consent: false },
    { gateway: "absent" as const },
    { gateway: false },
  ]) {
    const app = makeOwnerPairingFixture(options);
    try {
      expect((await app.handler(request())).status).toBe(503);
      expect(app.issued()).toBe(0);
    } finally {
      await app.dispose();
    }
  }
});
it("rejects malformed, extra, oversized, query-bearing and wrong-authority requests without issuance", async () => {
  const app = makeOwnerPairingFixture();
  try {
    for (const body of [
      { ...ownerInput, token: "unexpected" },
      { ...ownerInput, backendOrigin: "http://insecure.invalid" },
      { ...ownerInput, scope: "admin" },
      { ...ownerInput, extra: "x".repeat(16 * 1024) },
    ])
      expect((await app.handler(request(body))).status).toBe(400);
    for (const suffix of ["?", "?secret=bad"])
      expect((await app.handler(request(ownerInput, ownerHeaders, suffix))).status).toBe(400);
    expect(
      (await app.handler(request({ ...ownerInput, authorityId: "d".repeat(32) }))).status,
    ).toBe(409);
    expect(app.issued()).toBe(0);
  } finally {
    await app.dispose();
  }
});
it("issues only a host-served intentional pair link and does not expose backend credentials", async () => {
  const app = makeOwnerPairingFixture();
  try {
    const response = await app.handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = decodeMobileOwnerPairingResult(await response.json(), ownerInput);
    expect(value).toMatchObject({ scope: "approve-only", secret: "fixture-secret" });
    expect(value.pairUrl).toBe(
      "https://fixture.ts.net/mobile/pair/fixture-pair?backend=https%3A%2F%2Ffixture.ts.net#secret=fixture-secret",
    );
    expect(JSON.stringify(value)).not.toContain("private-owner-fixture");
    expect(app.issued()).toBe(1);
    for (const path of ["/api/mobile/pairing/new", "/api/internal/thread-tools", "/mobile-ws"])
      expect(
        (await app.handler(new Request(`http://owner.invalid${path}`, { headers: ownerHeaders })))
          .status,
      ).toBe(404);
  } finally {
    await app.dispose();
  }
});
it("returns generic safe service failures", async () => {
  const app = makeOwnerPairingFixture({ serviceError: true });
  try {
    const response = await app.handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_TOKEN_MUST_NOT_ECHO");
  } finally {
    await app.dispose();
  }
});
it("bounds a held request body by the real five-second deadline", async () => {
  const app = makeOwnerPairingFixture();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
  });
  try {
    const started = Date.now();
    const response = await app.handler(
      new Request(
        `http://owner.invalid${MOBILE_OWNER_PAIRING_PATH}`,
        Object.assign({ method: "POST", headers: ownerHeaders, body }, { duplex: "half" as const }),
      ),
    );
    expect(response.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(7000);
    expect(app.issued()).toBe(0);
  } finally {
    await app.dispose();
  }
});

it("matches the verified gateway external origin before issuing a target link", async () => {
  for (const [verifiedOrigin, expected] of [
    [null, 503],
    ["https://other.ts.net", 409],
    ["https://fixture.ts.net/", 503],
  ] as const) {
    const app = makeOwnerPairingFixture({ verifiedOrigin });
    try {
      expect((await app.handler(request())).status).toBe(expected);
      expect(app.issued()).toBe(0);
    } finally {
      await app.dispose();
    }
  }
});
