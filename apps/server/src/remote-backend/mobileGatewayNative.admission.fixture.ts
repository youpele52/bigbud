/** Actual publication/journal CAS + actual opaque owner client over a scripted native wire. */
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { publicationFixture } from "../remote-agent/mobileOptionalPublication.test-fixtures.ts";
import { nativeOwnershipFixture } from "../remote-agent/mobileGatewayLifecycle.native.fixture.ts";
import {
  gatewayConfiguration,
  gatewayContext,
  gatewayFixtureOwnerStore,
} from "../remote-agent/mobileGatewayLifecycle.test-fixtures.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { setRemoteAgentMobileConsent } from "../remote-agent/remoteAgentInstall.mobile.transitions.ts";
import {
  successorFixture,
  type SuccessorReply,
} from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import { spawnedReply } from "./mobileGatewayActivation.native.fixture.ts";
import { mobileGatewayNativeAdmission } from "./mobileGatewayNative.admission.ts";

type Registry = Extract<RemoteAgentRegistry, { readonly schemaVersion: 3 }>;
export interface NativeAdmissionScenario {
  /** Native status replies for successive liveness reads (Start always grants generation 2). */
  readonly status?: SuccessorReply[];
  /** Leave the journal row `reserved`: Start happens without the durable `attempted` fence. */
  readonly skipInvoked?: boolean;
}

export async function withNativeAdmission<A>(
  scenario: NativeAdmissionScenario,
  body: (context: {
    readonly admission: Awaited<ReturnType<typeof mobileGatewayNativeAdmission>>;
    /** Mirror the durable registry for the lock-free reread, optionally edited first. */
    readonly mirror: (edit?: (state: Registry) => RemoteAgentRegistry) => Promise<void>;
    readonly wire: () => string[];
  }) => Promise<A>,
): Promise<A> {
  const f = await publicationFixture({ ownerStartedAt: "start-v2:linux:fixture-boot:123" });
  try {
    return await f.run(async (publisher) => {
      const proof = await publisher.publish(f.request);
      const wire = successorFixture(
        { start: [spawnedReply], status: [...(scenario.status ?? [])] },
        { epoch: gatewayContext(f).binding.epoch },
      );
      const n = await nativeOwnershipFixture(f, proof, "", { connection: wire.connection });
      try {
        const intent = await n.api.reserve(n.assets, n.client, n.pending);
        if (!intent) throw Error("Fixture reservation was not admitted.");
        if (!scenario.skipInvoked) await n.api.markInvoked(intent);
        const lease = await n.client.start(n.pending);
        const directory = join(f.control.root, "control-v1");
        const mirror = async (
          edit: (state: Registry) => RemoteAgentRegistry = (state) => state,
        ) => {
          const state = f.read();
          if (state.schemaVersion !== 3) throw Error("Fixture journal missing.");
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, "registry.json");
          await fs.writeFile(path, JSON.stringify(edit(state)), { mode: 0o600 });
          await fs.chmod(path, 0o600);
        };
        await mirror();
        const admission = await mobileGatewayNativeAdmission({
          proof,
          client: n.client,
          pending: n.pending,
          lease,
          nonce: n.client.binding(n.pending).nonce,
          port: gatewayConfiguration.port,
          externalOrigin: gatewayConfiguration.externalOrigin,
          owners: gatewayFixtureOwnerStore(f),
          signal: new AbortController().signal,
        });
        try {
          return await body({ admission, mirror, wire: wire.sent });
        } finally {
          await admission.close();
        }
      } finally {
        await n.close();
      }
    });
  } finally {
    await f.close();
  }
}

/** Actual consent transition (revision bump, stages fenced), as the owner's revoke/enable does. */
export function setConsent(state: RemoteAgentRegistry, enabled: boolean): Registry {
  if (state.schemaVersion !== 3) throw Error("Fixture journal missing.");
  const next = setRemoteAgentMobileConsent(
    state,
    { owner: state.mobile.owner, expectedConsentRevision: state.mobile.consent.revision },
    enabled,
  );
  if (next.schemaVersion !== 3) throw Error("Fixture journal missing.");
  return next;
}
/** Rewrite this fixture's single native attempt row. */
export function editAttempt(
  state: Registry,
  edit: (
    attempt: NonNullable<Registry["mobile"]["gatewayLifecycle"]>["attempts"][number],
  ) => object,
): Registry {
  const lifecycle = state.mobile.gatewayLifecycle!;
  return {
    ...state,
    mobile: {
      ...state.mobile,
      gatewayLifecycle: {
        ...lifecycle,
        attempts: lifecycle.attempts.map((attempt) => Object.assign({}, attempt, edit(attempt))),
      },
    },
  };
}
