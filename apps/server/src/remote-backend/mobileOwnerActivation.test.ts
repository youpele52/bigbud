import { expect, it } from "vitest";
import type { MobileActivationController } from "./mobileGatewayActivation.state.ts";
import { MOBILE_CONSENT_CONFIRMATION } from "./mobileOwnerActivation.protocol.ts";
import {
  activationHeaders,
  activationRequest,
  makeOwnerActivationFixture,
  ownerAuthority,
} from "./mobileOwnerActivation.test.helpers.ts";

const grant = (extra: Record<string, unknown> = {}) => ({
  action: "consent-enable",
  authorityId: ownerAuthority,
  confirmation: MOBILE_CONSENT_CONFIRMATION,
  expectedRevision: 2,
  ...extra,
});
const activate = {
  action: "activate",
  authorityId: ownerAuthority,
  requestId: "00000000-0000-4000-8000-000000000001",
  configuration: { externalOrigin: "https://fixture.ts.net", port: 49322 },
};
async function send(app: Awaited<ReturnType<typeof makeOwnerActivationFixture>>, body: unknown) {
  const response = await app.handler(activationRequest(body));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

it("denies non-owners before reading the body or touching the journal", async () => {
  const app = await makeOwnerActivationFixture();
  try {
    expect((await app.handler(activationRequest(grant(), {}))).status).toBe(401);
    const wrongToken = { ...activationHeaders, authorization: "Bearer someone-else" };
    expect((await app.handler(activationRequest(grant(), wrongToken))).status).toBe(401);
    expect(await send(app, grant({ authorityId: "b".repeat(32) }))).toEqual({
      status: 409,
      body: { refused: "authority-mismatch" },
    });
    expect(app.enables).toEqual([]);
  } finally {
    await app.dispose();
  }
});

it("refuses consent-enable without the explicit confirmation literal", async () => {
  const app = await makeOwnerActivationFixture();
  try {
    for (const body of [
      grant({ confirmation: undefined }),
      grant({ confirmation: "yes" }),
      grant({ confirmation: true }),
      grant({ expectedRevision: -1 }),
      grant({ extra: 1 }),
    ])
      expect(await send(app, body)).toEqual({ status: 400, body: { refused: "invalid-request" } });
    expect(app.enables).toEqual([]);
    expect(app.consent()).toEqual({ enabled: false, revision: 2 });
  } finally {
    await app.dispose();
  }
});

it("grants by revision CAS: bump on change, keep when already granted, refuse stale", async () => {
  const app = await makeOwnerActivationFixture();
  try {
    expect(await send(app, grant({ expectedRevision: 1 }))).toEqual({
      status: 409,
      body: { refused: "stale-revision" },
    });
    expect(app.settingsEnabled()).toBe(false);
    expect(await send(app, grant())).toEqual({
      status: 200,
      body: { enabled: true, revision: 3, changed: true, settingsEnabled: true },
    });
    // The grant turned settings mobile access on, so the startup guard keeps it.
    expect(app.settingsEnabled()).toBe(true);
    expect(await send(app, grant({ expectedRevision: 3 }))).toEqual({
      status: 200,
      body: { enabled: true, revision: 3, changed: false, settingsEnabled: true },
    });
  } finally {
    await app.dispose();
  }
});

it("activate and stop are unavailable/no-op without an attached controller", async () => {
  const app = await makeOwnerActivationFixture();
  try {
    expect(await send(app, activate)).toEqual({
      status: 200,
      body: { requestId: null, status: "unavailable" },
    });
    expect(await send(app, { action: "stop", authorityId: ownerAuthority })).toEqual({
      status: 200,
      body: { stopped: true },
    });
    expect(
      await send(app, { ...activate, configuration: { externalOrigin: "http://x", port: 1 } }),
    ).toMatchObject({ status: 400 });
  } finally {
    await app.dispose();
  }
});

it("routes activate/stop to the attached controller and reports its phase in status", async () => {
  const seen: unknown[] = [];
  let stopFails = false;
  const controller: MobileActivationController = {
    activate: async (input) => (
      seen.push(input), { requestId: activate.requestId, status: "accepted" }
    ),
    resume: async () => ({ requestId: null, status: "retired" }),
    stop: async () => {
      if (stopFails) throw Error("PRIVATE uncertain detail");
    },
    close: async () => {},
    status: () => ({
      phase: "uncertain-repair",
      lastOutcome: {
        kind: "failed",
        repairRequired: true,
        at: "2026-11-17T00:00:00.000Z",
        reason: "route-unverified",
        detail: "MobileGatewayRouteUnverified",
      },
    }),
  };
  const app = await makeOwnerActivationFixture({
    controller,
    consent: { enabled: true, revision: 4 },
    inputs: { kind: "invalid", reason: "unsafe-file" },
  });
  try {
    expect(await send(app, activate)).toEqual({
      status: 200,
      body: { requestId: activate.requestId, status: "accepted" },
    });
    expect(seen).toEqual([
      { requestId: activate.requestId, configuration: activate.configuration },
    ]);
    stopFails = true;
    const refused = await send(app, { action: "stop", authorityId: ownerAuthority });
    expect(refused).toEqual({ status: 409, body: { refused: "uncertain" } });
    expect(JSON.stringify(refused)).not.toContain("PRIVATE");
    expect(await send(app, { action: "status", authorityId: ownerAuthority })).toEqual({
      status: 200,
      body: {
        authorityId: ownerAuthority,
        controller: {
          attached: true,
          retiring: false,
          // A failed stop stays pending in the activation state: no relaunch until retirement.
          stopping: true,
          phase: "uncertain-repair",
          lastOutcome: {
            kind: "failed",
            repairRequired: true,
            at: "2026-11-17T00:00:00.000Z",
            reason: "route-unverified",
            detail: "MobileGatewayRouteUnverified",
          },
          lastRepair: null,
        },
        consent: { state: "enabled", revision: 4 },
        inputs: { state: "invalid", reason: "unsafe-file" },
        settingsEnabled: false,
      },
    });
  } finally {
    await app.dispose();
  }
});

it("is unavailable outside remote mode", async () => {
  const app = await makeOwnerActivationFixture({ remote: false });
  try {
    expect(await send(app, { action: "status", authorityId: ownerAuthority })).toEqual({
      status: 503,
      body: { refused: "unavailable" },
    });
  } finally {
    await app.dispose();
  }
});
