/** Real publisher, real files and the real CAS store for stage-retirement tests. */
// First: its supervisor-runner mock must be registered before any journal module loads.
import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";
import { mobileStageIdForConsent } from "../remote-backend/mobileGatewayActivation.stage.ts";
import { selectMobileGatewayDesired } from "./mobileGatewayActivation.selection.transitions.ts";
import type { MobileNativeGatewayOwnership } from "./mobileGatewayLifecycle.native.schema.ts";
import {
  completeNativeMobileGatewayAttempt,
  reserveNativeMobileGatewayAttempt,
} from "./mobileGatewayLifecycle.native.transitions.ts";
import { advanceMobileGatewayAttempt } from "./mobileGatewayLifecycle.transitions.ts";
import { gatewayConfiguration, gatewayContext } from "./mobileGatewayLifecycle.test-fixtures.ts";
import { MOBILE_COMPONENT_NAMESPACE } from "./mobileOptionalPublication.files.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { setRemoteAgentMobileConsent } from "./remoteAgentInstall.mobile.transitions.ts";
import type { MobileRegistry } from "./remoteAgentInstall.mobile.schema.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

export async function retirementFixture() {
  const f = await publicationFixture({ ownerStartedAt: "start-v2:linux:fixture-boot:123" });
  fixtures.push(f);
  const store = makeRemoteAgentRegistryStore("/tmp/retirement-registry", f.command());
  let clock = 100_000;
  let nonces = 0;
  const mobile = (): MobileRegistry => {
    const state = f.read();
    if (state.schemaVersion !== 3) throw Error("Missing mobile journal.");
    return state.mobile;
  };
  /** Publish (which retires first) this revision's stage; returns its id. */
  const publish = async () => {
    const revision = mobile().consent.revision;
    const stageId = mobileStageIdForConsent(mobile(), f.request.stageId, revision);
    await f.run((publisher) =>
      publisher.publish({ ...f.request, stageId, consentRevision: revision }),
    );
    return stageId;
  };
  const stage = (id: string) => mobile().stages.find((s) => s.id === id)!;
  const select = (stageId: string) =>
    store.update((state) =>
      selectMobileGatewayDesired(
        state,
        {
          owner: f.pin,
          expectedConsentRevision: stage(stageId).consentRevision,
          stageId,
          releaseId: stage(stageId).releaseId,
        },
        { requestId: randomUUID(), configuration: gatewayConfiguration },
      ),
    );
  /** Reserve a native original on the stage; `attempted` leaves it live (pinned, unsettled). */
  const original = async (stageId: string, phase: "reserved" | "attempted" = "reserved") => {
    clock += 10 * 60_000; // Outside the crash-restart window.
    const row = stage(stageId);
    const release = mobile().releases.find((r) => r.id === row.releaseId)!;
    const context = {
      ...gatewayContext(f),
      controller: row.controller,
      stageId,
      releaseId: row.releaseId,
      consentRevision: row.consentRevision,
      now: clock,
    };
    nonces += 1;
    const ownership: MobileNativeGatewayOwnership = {
      binding: {
        authority: context.owner.authority.authorityId,
        installation: context.owner.installationFingerprint,
        nativeEpoch: context.binding.epoch,
        nonce: `native-${nonces}`,
        publicationSha256: row.releaseId.slice(15),
        executableSha256: release.gateway.sha256,
        assetsSha256: release.assets.sha256,
        configurationSha256: "1".repeat(64),
        guardSha256: "2".repeat(64),
      },
      assetsReference: {
        schemaVersion: 1,
        generation: `assets-${nonces.toString(16).padStart(32, "0")}`,
        sizeBytes: 1024,
        sha256: "4".repeat(64),
      },
      assetsArgument: "--assets-dir",
    };
    await store.update((s) => reserveNativeMobileGatewayAttempt(s, context, ownership));
    if (phase === "attempted")
      await store.update((s) =>
        advanceMobileGatewayAttempt(s, context, ownership.binding.nonce, "attempted"),
      );
    return ownership;
  };
  /** Settle the original with native terminal evidence (exit recorded). */
  const settle = (ownership: MobileNativeGatewayOwnership) =>
    store.update((s) =>
      completeNativeMobileGatewayAttempt(s, f.pin, ownership, { kind: "native-cancel" }, clock),
    );
  const consent = (enabled: boolean) =>
    store.update((s) =>
      setRemoteAgentMobileConsent(
        s,
        { owner: f.pin, expectedConsentRevision: mobile().consent.revision },
        enabled,
      ),
    );
  /** Revoke then grant again: a new consent revision fences every earlier stage. */
  const regrant = async () => {
    await consent(false);
    await consent(true);
  };
  const retire = () => f.run((publisher) => publisher.retire());
  const namespace = join(f.control.root, MOBILE_COMPONENT_NAMESPACE);
  const directory = (stageId: string) => join(namespace, stage(stageId).publicationIntent!.key);
  const published = async () =>
    (await fs.readdir(namespace)).filter((name) => /^[a-f0-9]{64}$/.test(name));
  const exists = (path: string) =>
    fs.lstat(path).then(
      () => true,
      () => false,
    );
  return {
    f,
    store,
    mobile,
    publish,
    select,
    original,
    settle,
    consent,
    regrant,
    retire,
    directory,
    published,
    exists,
  };
}
