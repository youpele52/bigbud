import "../remote-agent/mobileGatewayLifecycle.native.test-boundaries.ts";
import * as fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { publicationFixture } from "../remote-agent/mobileOptionalPublication.test-fixtures.ts";
import {
  buildNativeOwnershipFixturePeer,
  nativeOwnershipFixture,
} from "../remote-agent/mobileGatewayLifecycle.native.fixture.ts";
import { withMobilePublicationTeardown } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { mobileGatewayAssetsPath } from "./mobileGatewayProcess.assets.ts";
import { recordNativeMobileSuccessorExit } from "./mobileGatewayNative.successorExit.ts";

let peer = "";
let closePeer: (() => Promise<void>) | undefined;
const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
beforeAll(async () => {
  const built = await buildNativeOwnershipFixturePeer();
  peer = built.peer;
  closePeer = built.close;
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
afterAll(async () => {
  await closePeer?.();
});

it("records a confirmed exit journal-only through the publication authority and keeps the tree", async () => {
  const f = await publicationFixture({ ownerStartedAt: "start-v2:linux:fixture-boot:123" });
  fixtures.push(f);
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      n = await nativeOwnershipFixture(f, proof, peer);
    try {
      await n.api.markInvoked((await n.api.reserve(n.assets, n.client, n.pending))!);
      await n.client.start(n.pending);
      const state = f.read();
      const attempt = state.schemaVersion === 3 && state.mobile.gatewayLifecycle?.attempts[0];
      if (!attempt || !attempt.nativeOwnership) throw Error("Fixture attempt missing.");
      const original = attempt.nativeOwnership;
      const result = await n.client.stopOriginal(n.pending);
      if (result.state !== "exited") throw Error("Controlled exit missing.");
      const record = (ownership: typeof original, client = n.client) =>
        withMobilePublicationTeardown(proof, (authority, signal) =>
          recordNativeMobileSuccessorExit(
            authority,
            client,
            n.pending,
            ownership,
            result.exit,
            signal,
          ),
        );
      const foreign = {
        ...original,
        binding: { ...original.binding, guardSha256: "0".repeat(64) },
      };
      await expect(record(foreign)).rejects.toThrow(/retained original intent/);
      await expect(record(original, { ...n.client })).rejects.toThrow(/Original authenticated/);
      expect(f.read().pins.map((p) => p.owner)).toContain(mobileGatewayBuildPin(attempt.nonce));
      await record(original);
      const terminal = f.read();
      const settled = terminal.schemaVersion === 3 && terminal.mobile.gatewayLifecycle?.attempts[0];
      expect(settled).toMatchObject({
        phase: "exit-confirmed",
        completionEvidence: { kind: "native-exit" },
      });
      expect(terminal.pins.map((p) => p.owner)).not.toContain(mobileGatewayBuildPin(attempt.nonce));
      // Journal-only: the runtime assets tree stays for the increment-7 repair/GC path.
      await expect(fs.lstat(mobileGatewayAssetsPath(n.assets))).resolves.toBeTruthy();
      // Recording the same immutable evidence again is a no-op, never a second terminal.
      await record(original);
      expect(f.read().revision).toBe(terminal.revision);
    } finally {
      await n.close();
    }
  });
});
