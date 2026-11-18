/** Explicit offline integration entry; TEST P4 peer/signer/route, actual Rust executable. */
import { nextRemoteAgentRegistryRevision } from "../remote-agent/remoteAgentAdmission.types.ts";
import { commitMobileGatewayDesiredSelection } from "./mobileGatewayActivation.selection.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { join } from "node:path";
import { Effect } from "effect";
import { ownerIntegrationArtifacts } from "./mobileGatewayOwner.integration.artifacts.ts";
import { createOwnerIntegrationFixture } from "./mobileGatewayOwner.integration.fixture.ts";
import { withMobileOptionalPublisher } from "../remote-agent/mobileOptionalPublication.ts";
import {
  withMobileGatewayProcess,
  readVerifiedMobileGatewayProcess,
  type VerifiedMobileGatewayProcess,
} from "./mobileGatewayProcess.ts";
const artifacts = await ownerIntegrationArtifacts(),
  fixture = await createOwnerIntegrationFixture(artifacts);
const endpoint = net.createServer();
await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
const address = endpoint.address();
if (!address || typeof address === "string") throw Error("port unavailable");
const port = address.port;
await new Promise<void>((r) => endpoint.close(() => r()));
let retained: VerifiedMobileGatewayProcess | undefined,
  callbacks = 0;
try {
  await Effect.runPromise(
    fixture.settings.updateSettings({ mobileRemoteControl: { enabled: true } }),
  );
  await Effect.runPromise(
    withMobileOptionalPublisher(artifacts.keys, async (publisher) => {
      const proof = await publisher.publish(artifacts.request);
      await fixture.store.update((state) => {
        if (!state.current) throw Error("missing selected build");
        return nextRemoteAgentRegistryRevision(state, {
          currentConnectionId: "racing-P4",
          admissions: [
            ...state.admissions,
            {
              id: "racing-P4",
              buildId: state.current,
              phase: "ready",
              epoch: state.launches[0]!.epoch!,
            },
          ],
        });
      });
      await assert.rejects(
        Effect.runPromise(
          commitMobileGatewayDesiredSelection(proof, "00000000-0000-4000-8000-000000000001", {
            externalOrigin: "https://fixture.example",
            port,
          }).pipe(Effect.provide(fixture.runtimeLayer)),
        ),
      );
      const refused = await fixture.store.read();
      if (refused.schemaVersion !== 3) throw Error("missing v3");
      assert.equal(refused.mobile.desired, undefined);
      await fixture.store.update((state) =>
        nextRemoteAgentRegistryRevision(state, { currentConnectionId: null }),
      );
      const config = { externalOrigin: "https://fixture.example", port };
      const held = fixture.holdBindingReads();
      const selecting = Effect.runPromise(
        commitMobileGatewayDesiredSelection(
          proof,
          "00000000-0000-4000-8000-000000000001",
          config,
        ).pipe(Effect.provide(fixture.runtimeLayer)),
      );
      await held.began;
      config.externalOrigin = "https://mutated.example";
      config.port = port + 1;
      held.release();
      const selected = await selecting;
      assert.equal(selected.revision, 1);
      assert.equal(selected.stageId, artifacts.request.stageId);
      assert.deepEqual(selected.configuration, { externalOrigin: "https://fixture.example", port });
      const joined = await Effect.runPromise(
        commitMobileGatewayDesiredSelection(proof, "00000000-0000-4000-8000-000000000001", {
          externalOrigin: "https://fixture.example",
          port,
        }).pipe(Effect.provide(fixture.runtimeLayer)),
      );
      assert.deepEqual(joined, selected);
      const result = await Effect.runPromise(
        withMobileGatewayProcess(
          proof,
          { nonce: "real-rust-process", externalOrigin: "https://fixture.example", port },
          async (token, signal) => {
            retained = token;
            callbacks++;
            const before = fixture.requests();
            const first = readVerifiedMobileGatewayProcess(token),
              second = readVerifiedMobileGatewayProcess(token);
            assert.equal(first, second);
            const stamp = await first;
            assert.equal(stamp.consentRevision, 1);
            assert.deepEqual(stamp.authority, fixture.identity.authority);
            assert.equal(stamp.installationFingerprint, fixture.identity.installationFingerprint);
            assert.equal(stamp.backendExternalOrigin, "https://fixture.example");
            assert.equal(fixture.requests(), before);
            const hold = fixture.holdBindingReads(),
              oneClient = new AbortController();
            const cancelled = readVerifiedMobileGatewayProcess(token, oneClient.signal);
            const admitted = readVerifiedMobileGatewayProcess(token);
            await hold.began;
            oneClient.abort(Error("one client disconnected"));
            await assert.rejects(cancelled, /one client disconnected/);
            assert.equal(signal.aborted, false);
            hold.release();
            assert.deepEqual(await admitted, stamp);
            const staggeredHold = fixture.holdBindingReads();
            const early = readVerifiedMobileGatewayProcess(token);
            await staggeredHold.began;
            const later: Promise<unknown>[] = [];
            for (let i = 0; i < 16; i++) {
              await new Promise<void>((r) => setImmediate(r));
              later.push(readVerifiedMobileGatewayProcess(token));
            }
            staggeredHold.release();
            assert.deepEqual(await early, stamp);
            for (const value of await Promise.all(later)) assert.deepEqual(value, stamp);
            assert.equal(signal.aborted, false);
            const response = await fetch(`http://127.0.0.1:${port}/mobile/`, {
              headers: { host: "fixture.example", origin: "https://fixture.example" },
            });
            assert.equal(response.status, 200);
            assert.match(await response.text(), /disposable owner integration fixture/);
            return "verified real gateway process";
          },
        ).pipe(Effect.provide(fixture.runtimeLayer)),
      );
      assert.equal(result, "verified real gateway process");
      assert.equal(callbacks, 1);
      await assert.rejects(readVerifiedMobileGatewayProcess(retained!));
      const state = await fixture.store.read();
      if (state.schemaVersion !== 3) throw Error("missing journal");
      assert.equal(state.mobile.gatewayLifecycle!.attempts[0]!.phase, "exit-confirmed");
      assert.equal(state.pins.length, 0);
      assert.deepEqual(
        await fs.readdir(join(fixture.owner.stateDir, "remote-mobile-runtime-v1")),
        [],
      );
      console.log(
        "Actual selected-P4 mismatch refusal+held-P4 caller configuration snapshot+settings-barrier desired CAS selection+idempotent retry+signed Rust Linux gateway +sealed credential UDS +owned CAS child +identity/RPC probe +signed assets +joined isolated caller reads +confirmed cleanup PASS",
      );
    }).pipe(Effect.provide(fixture.runtimeLayer)),
  );
} finally {
  await fixture.close();
}
