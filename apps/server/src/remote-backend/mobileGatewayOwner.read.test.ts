import { expect, it } from "vitest";
import { MobileGatewayOwnerState } from "./mobileGatewayOwner.state.ts";
import {
  readCurrentMobileGatewayAdmission,
  type ActiveMobileGatewayAdmission,
} from "./mobileGatewayOwner.read.ts";
import type { RemoteMobileAdmissionStamp } from "../mobile/Services/MobileRemoteControlAdmission.ts";

const stamp: RemoteMobileAdmissionStamp = {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  consentRevision: 1,
  backendExternalOrigin: "https://fixture.ts.net",
};
function fixture(read: ActiveMobileGatewayAdmission["read"]) {
  const state = new MobileGatewayOwnerState();
  const lease = state.begin();
  lease.admit();
  return { state, lease, active: { lease, stamp, read } };
}

it("cancels one held RPC read without retiring the shared gateway", async () => {
  const f = fixture(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("caller cancelled")), {
          once: true,
        });
      }),
  );
  const controller = new AbortController();
  const read = readCurrentMobileGatewayAdmission(() => f.active, controller.signal);
  controller.abort();
  expect(await read).toBeNull();
  expect(f.lease.isAdmitted()).toBe(true);
  expect(f.state.getPhase()).toBe("running");
});

it("rejects a durable consent revision change and retires its old admission", async () => {
  const f = fixture(async () => ({ ...stamp, consentRevision: 2 }));
  expect(
    await readCurrentMobileGatewayAdmission(() => f.active, new AbortController().signal),
  ).toBeNull();
  expect(f.lease.isAdmitted()).toBe(false);
  expect(f.lease.endReason()).toBe("revoked");
});

it("cannot publish a held old read after a replacement has become active", async () => {
  let release!: (value: RemoteMobileAdmissionStamp) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let active: ActiveMobileGatewayAdmission = f.active;
  const oldRead = readCurrentMobileGatewayAdmission(() => active, new AbortController().signal);
  f.lease.invalidate("disabled");
  f.lease.settle(true);
  const replacement = f.state.begin();
  replacement.admit();
  active = { lease: replacement, stamp, read: async () => stamp };
  release(stamp);
  expect(await oldRead).toBeNull();
  expect(replacement.isAdmitted()).toBe(true);
  expect(
    await readCurrentMobileGatewayAdmission(() => active, new AbortController().signal),
  ).toEqual(stamp);
});
