import { expect, it } from "vitest";
import { MOBILE_CONSENT_CONFIRMATION } from "./mobileOwnerActivation.protocol.ts";
import {
  activationRequest,
  makeOwnerActivationFixture,
  ownerAuthority,
} from "./mobileOwnerActivation.test.helpers.ts";

const grant = {
  action: "consent-enable",
  authorityId: ownerAuthority,
  confirmation: MOBILE_CONSENT_CONFIRMATION,
  expectedRevision: 2,
};
const status = { action: "status", authorityId: ownerAuthority };
async function send(app: Awaited<ReturnType<typeof makeOwnerActivationFixture>>, body: unknown) {
  const response = await app.handler(activationRequest(body));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// F1: the handler reads the journal at request time; app-wide services never include it.
it("the composed route reaches the request-scoped journal and the attach-recorded inputs", async () => {
  const app = await makeOwnerActivationFixture({
    inputs: { kind: "invalid", reason: "malformed" },
  });
  try {
    expect((await send(app, status)).body).toMatchObject({
      consent: { state: "disabled", revision: 2 },
      inputs: { state: "invalid", reason: "malformed" },
    });
    expect(await send(app, grant)).toEqual({
      status: 200,
      body: { enabled: true, revision: 3, changed: true, settingsEnabled: true },
    });
    expect(app.enables).toEqual([2]);
  } finally {
    await app.dispose();
  }
});

it("layer-level journal provision never reaches the handler (the pre-fix wiring)", async () => {
  const app = await makeOwnerActivationFixture({ legacy: true });
  try {
    expect((await send(app, status)).body).toMatchObject({
      consent: { state: "unavailable", revision: null },
    });
    expect(await send(app, grant)).toEqual({ status: 503, body: { refused: "unavailable" } });
    expect(app.enables).toEqual([]);
    expect(app.settingsEnabled()).toBe(false);
  } finally {
    await app.dispose();
  }
});

it("a stale grant refuses before turning settings mobile access on", async () => {
  const app = await makeOwnerActivationFixture();
  try {
    expect(await send(app, { ...grant, expectedRevision: 1 })).toEqual({
      status: 409,
      body: { refused: "stale-revision" },
    });
    expect(app.settingsEnabled()).toBe(false);
    expect(app.enables).toEqual([]);
  } finally {
    await app.dispose();
  }
});
