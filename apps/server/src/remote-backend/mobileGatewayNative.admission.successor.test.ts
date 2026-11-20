import "../remote-agent/mobileGatewayLifecycle.native.test-boundaries.ts";
import { expect, it } from "vitest";
import { spawnedReply } from "./mobileGatewayActivation.native.fixture.ts";
import { editAttempt, withNativeAdmission } from "./mobileGatewayNative.admission.fixture.ts";
// After the fixture: its module mock must load before the admission module's runner.
import { MobileGatewayNativeAdmissionRefused } from "./mobileGatewayNative.admission.ts";

/** A dead predecessor that started the original; this fixture's backend is the successor. */
const predecessor = {
  id: "predecessor-nonce",
  pid: 4242,
  startedAt: "start-v2:linux:fixture-boot:7",
};

// F4: a successor selects rows whose controller is foreign, so admission must accept the
// durably adopted current controller, and only that.
it("admits a successor only after the journal records it as the current controller", async () => {
  await withNativeAdmission(
    {
      status: [spawnedReply],
      journal: (state) =>
        editAttempt(state, (attempt) => ({
          controller: predecessor,
          currentController: attempt.controller,
        })),
    },
    async (f) => {
      const stamp = await f.admission.read();
      expect(stamp.consentRevision).toBe(1);
    },
  );
});

it("refuses a foreign original that no successor adopted durably", async () => {
  const refused = await withNativeAdmission(
    {
      status: [spawnedReply],
      journal: (state) => editAttempt(state, () => ({ controller: predecessor })),
    },
    async () => {},
  ).then(
    () => undefined,
    (cause: unknown) => (cause as { readonly cause?: unknown }).cause ?? cause,
  );
  expect(refused).toBeInstanceOf(MobileGatewayNativeAdmissionRefused);
});
