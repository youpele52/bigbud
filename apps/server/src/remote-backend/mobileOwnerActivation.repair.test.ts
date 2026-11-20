import { expect, it } from "vitest";
import type { MobileActivationController } from "./mobileGatewayActivation.state.ts";
import type { MobileRuntimeRepairReport } from "./mobileGatewayAssets.orphan.ts";
import {
  activationHeaders,
  activationRequest,
  makeOwnerActivationFixture,
  ownerAuthority,
} from "./mobileOwnerActivation.test.helpers.ts";

const repairBody = { action: "repair", authorityId: ownerAuthority };
const report: MobileRuntimeRepairReport = {
  removed: 1,
  kept: 1,
  entries: [
    { generation: `assets-${"1".repeat(32)}`, outcome: "removed", reason: "proven-orphan" },
    { generation: `assets-${"2".repeat(32)}`, outcome: "kept", reason: "identity-mismatch" },
  ],
};
async function send(app: Awaited<ReturnType<typeof makeOwnerActivationFixture>>, body: unknown) {
  const response = await app.handler(activationRequest(body));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
function controller(repair: () => Promise<MobileRuntimeRepairReport>) {
  const calls = { repair: 0 };
  let last: { at: string; removed: number; kept: number; failed: boolean } | null = null;
  const value: MobileActivationController = {
    activate: async () => ({ requestId: null, status: "unavailable" }),
    resume: async () => ({ requestId: null, status: "retired" }),
    stop: async () => {},
    close: async () => {},
    status: () => ({ phase: "idle", lastOutcome: null, lastRepair: last }),
    repair: async () => {
      calls.repair++;
      const result = await repair();
      last = {
        at: "2026-11-17T00:00:00.000Z",
        removed: result.removed,
        kept: result.kept,
        failed: false,
      };
      return result;
    },
  };
  return { value, calls };
}

it("refuses repair for non-owners before running anything", async () => {
  const c = controller(async () => report);
  const app = await makeOwnerActivationFixture({ controller: c.value });
  try {
    expect((await app.handler(activationRequest(repairBody, {}))).status).toBe(401);
    const wrongToken = { ...activationHeaders, authorization: "Bearer someone-else" };
    expect((await app.handler(activationRequest(repairBody, wrongToken))).status).toBe(401);
    expect(await send(app, { ...repairBody, authorityId: "b".repeat(32) })).toEqual({
      status: 409,
      body: { refused: "authority-mismatch" },
    });
    expect(await send(app, { ...repairBody, force: true })).toEqual({
      status: 400,
      body: { refused: "invalid-request" },
    });
    expect(c.calls.repair).toBe(0);
  } finally {
    await app.dispose();
  }
});

it("is unavailable without an attached controller (default-off)", async () => {
  const app = await makeOwnerActivationFixture();
  try {
    expect(await send(app, repairBody)).toEqual({ status: 503, body: { refused: "unavailable" } });
  } finally {
    await app.dispose();
  }
});

it("reports kept/removed with reasons, then exposes the counts in status", async () => {
  const c = controller(async () => report);
  const app = await makeOwnerActivationFixture({ controller: c.value });
  try {
    expect(await send(app, repairBody)).toEqual({ status: 200, body: report });
    const status = await send(app, { action: "status", authorityId: ownerAuthority });
    expect(status.body.controller).toMatchObject({
      lastRepair: { at: "2026-11-17T00:00:00.000Z", removed: 1, kept: 1, failed: false },
    });
  } finally {
    await app.dispose();
  }
});

it("maps a failed repair to a fixed uncertain refusal without echoing the cause", async () => {
  const c = controller(() => Promise.reject(Error("PRIVATE /state/path")));
  const app = await makeOwnerActivationFixture({ controller: c.value });
  try {
    const refused = await send(app, repairBody);
    expect(refused).toEqual({ status: 409, body: { refused: "uncertain" } });
    expect(JSON.stringify(refused)).not.toContain("PRIVATE");
  } finally {
    await app.dispose();
  }
});
