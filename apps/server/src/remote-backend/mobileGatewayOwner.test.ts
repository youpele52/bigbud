import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import { RemoteMobileGatewayOwnerLive } from "./mobileGatewayOwner.ts";
import { RemoteMobileGatewayOwner } from "./mobileGatewayOwner.service.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import { RemoteMobileGatewayRouteOwner } from "./mobileGatewayOwner.route.ts";
import type { RemoteMobileAdmissionStamp } from "../mobile/Services/MobileRemoteControlAdmission.ts";

const unadmitted: RemoteMobileAdmissionStamp = {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  consentRevision: 1,
  backendExternalOrigin: "https://fixture.ts.net",
};

it("constructs both idle services without settings, SQL, filesystem owner or runtime services", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* RemoteMobileGatewayOwner;
        const again = yield* RemoteMobileGatewayOwner;
        const status = yield* RemoteMobileGatewayStatus;
        expect(owner).toBe(again);
        expect(owner.getPhase()).toBe("idle");
        expect(yield* status.ready).toBe(false);
        expect(status.verifiedExternalOrigin).toBeUndefined();
        expect(yield* status.readAdmission!()).toBeNull();
        expect(yield* status.watchAdmissionEnd!(unadmitted)).toBe("disabled");
      }).pipe(Effect.provide(RemoteMobileGatewayOwnerLive)),
    ),
  );
});

it("does not call an available route owner or expose its origin before a verified process lifetime", async () => {
  let routeCalls = 0;
  const routeOwner = Layer.succeed(RemoteMobileGatewayRouteOwner, {
    withRoute: async () => {
      routeCalls += 1;
      throw new Error("No process was admitted in this test.");
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* RemoteMobileGatewayStatus;
      expect(yield* status.ready).toBe(false);
      expect(yield* status.readAdmission!()).toBeNull();
      expect(status.verifiedExternalOrigin).toBeUndefined();
      expect(routeCalls).toBe(0);
    }).pipe(Effect.provide(RemoteMobileGatewayOwnerLive.pipe(Layer.provide(routeOwner)))),
  );
});
