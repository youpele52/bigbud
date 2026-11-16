import { MobileGatewayControllerHost } from "./mobileGatewayLifecycle.schema.ts";
import { Schema } from "effect";
import {
  assertMobileOptionalArtifactCompatibility,
  parseMobileOptionalArtifact,
  verifyMobileOptionalArtifactBytes,
  verifyMobileOptionalArtifactSignature,
  type MobileOptionalArtifactHost,
} from "@bigbud/shared/mobileOptionalArtifact";
import {
  MobileRegistryOwnerSchema,
  MobileRegistryControllerSchema,
  mobileRegistryOwnerEqual,
  mobileRegistryReleaseId,
  type MobileRegistry,
  type MobileRegistryOwner,
  type MobileRegistryController,
  type MobileRegistryRelease,
} from "./remoteAgentInstall.mobile.schema.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { parseAndValidateDownloadUrl } from "./remoteAgentHttpDownload.url.ts";

export interface MobileRegistryContext {
  /** From the existing authenticated/pinned backend owner; never inferred from a display name. */
  readonly owner: MobileRegistryOwner;
  readonly expectedConsentRevision: number;
}
export interface MobileStageContext extends MobileRegistryContext {
  readonly controller: MobileRegistryController;
  readonly controllerHost?: typeof MobileGatewayControllerHost.Type;
  readonly host: MobileOptionalArtifactHost;
  readonly trustedKeys: Readonly<Record<string, string>>;
}

function owner(context: MobileRegistryContext): MobileRegistryOwner {
  if (
    !Number.isSafeInteger(context.expectedConsentRevision) ||
    context.expectedConsentRevision < 0
  ) {
    throw new Error("Invalid expected mobile consent revision.");
  }
  return Schema.decodeUnknownSync(MobileRegistryOwnerSchema)(context.owner, {
    onExcessProperty: "error",
  });
}
function owned(state: RemoteAgentRegistry, context: MobileRegistryContext): MobileRegistry {
  const expected = owner(context);
  if (state.schemaVersion !== 3 || !mobileRegistryOwnerEqual(state.mobile.owner, expected)) {
    throw new Error("Mobile registry owner authority or installation mismatch.");
  }
  if (state.mobile.consent.revision !== context.expectedConsentRevision)
    throw new Error("Stale mobile consent revision.");
  return state.mobile;
}
function changed(state: RemoteAgentRegistry, mobile: MobileRegistry): RemoteAgentRegistry {
  return parseRemoteAgentRegistry(
    JSON.stringify({ ...state, schemaVersion: 3, mobile, revision: state.revision + 1 }),
  );
}
function controller(context: MobileStageContext): MobileRegistryController {
  return Schema.decodeUnknownSync(MobileRegistryControllerSchema)(context.controller, {
    onExcessProperty: "error",
  });
}
function controllerHost(context: MobileStageContext) {
  return context.controllerHost === undefined
    ? undefined
    : Schema.decodeUnknownSync(MobileGatewayControllerHost)(context.controllerHost, {
        onExcessProperty: "error",
      });
}
function sameController(a: MobileRegistryController, b: MobileRegistryController): boolean {
  return a.id === b.id && a.pid === b.pid && a.startedAt === b.startedAt;
}
function withPhase(
  stage: MobileRegistry["stages"][number],
  phase: MobileRegistry["stages"][number]["phase"],
): MobileRegistry["stages"][number] {
  return { ...stage, phase };
}
function verifiedRelease(
  context: MobileStageContext,
  gatewayInput: unknown,
  assetsInput: unknown,
): MobileRegistryRelease {
  const gateway = parseMobileOptionalArtifact(gatewayInput);
  const assets = parseMobileOptionalArtifact(assetsInput);
  if (
    gateway.kind !== "mobile-gateway" ||
    assets.kind !== "mobile-assets" ||
    JSON.stringify(gateway.compatibility) !== JSON.stringify(assets.compatibility)
  ) {
    throw new Error("Mobile staging requires one exact compatible signed component pair.");
  }
  for (const artifact of [gateway, assets]) {
    verifyMobileOptionalArtifactSignature(artifact, context.trustedKeys);
    assertMobileOptionalArtifactCompatibility(artifact, context.host, gateway.compatibility);
    parseAndValidateDownloadUrl(artifact.url, {});
  }
  return { id: mobileRegistryReleaseId(gateway, assets), gateway, assets };
}

/** The first separate mobile write fences old v2 controllers permanently, including revoke. */
export function setRemoteAgentMobileConsent(
  state: RemoteAgentRegistry,
  context: MobileRegistryContext,
  enabled: boolean,
): RemoteAgentRegistry {
  if (typeof enabled !== "boolean") throw new Error("Explicit mobile consent must be boolean.");
  const expectedOwner = owner(context);
  if (state.schemaVersion !== 3) {
    if (context.expectedConsentRevision !== 0)
      throw new Error("Stale initial mobile consent revision.");
    return changed(state, {
      owner: expectedOwner,
      consent: { revision: 1, enabled },
      releases: [],
      stages: [],
    });
  }
  const mobile = owned(state, context);
  if (mobile.consent.enabled === enabled) return state;
  return changed(state, {
    ...mobile,
    consent: { revision: mobile.consent.revision + 1, enabled },
    // Consent changes fence every old attempt; re-enable never resurrects an intent.
    stages: mobile.stages.map((stage) =>
      stage.phase === "cancelled" ? stage : withPhase(stage, "cancelled"),
    ),
  });
}

/** Pure CAS journal reservation; does not download, stage files, allocate a base slot or launch. */
export function reserveRemoteAgentMobileStage(
  state: RemoteAgentRegistry,
  context: MobileStageContext,
  request: { readonly id: string; readonly gateway: unknown; readonly assets: unknown },
): RemoteAgentRegistry {
  const mobile = owned(state, context);
  if (!mobile.consent.enabled) throw new Error("Separate mobile consent is disabled.");
  const lease = controller(context);
  const host = controllerHost(context);
  const release = verifiedRelease(context, request.gateway, request.assets);
  const prior = mobile.stages.find((stage) => stage.id === request.id);
  if (prior) {
    if (
      prior.releaseId !== release.id ||
      prior.consentRevision !== context.expectedConsentRevision ||
      !sameController(prior.controller, lease) ||
      JSON.stringify(prior.controllerHost) !== JSON.stringify(host) ||
      prior.phase === "cancelled"
    ) {
      throw new Error("Mobile stage request identity is fenced or conflicting.");
    }
    return state;
  }
  return changed(state, {
    ...mobile,
    releases: mobile.releases.some((entry) => entry.id === release.id)
      ? mobile.releases
      : [...mobile.releases, release],
    stages: [
      ...mobile.stages,
      {
        id: request.id,
        releaseId: release.id,
        consentRevision: context.expectedConsentRevision,
        controller: lease,
        ...(host ? { controllerHost: host } : {}),
        phase: "reserved",
      },
    ],
  });
}

/** Artifact-byte verification completion only: no filesystem publication or readiness claim. */
export function verifyRemoteAgentMobileStageBytes(
  state: RemoteAgentRegistry,
  context: MobileStageContext,
  request: {
    readonly id: string;
    readonly releaseId: string;
    readonly gatewayBytes: Uint8Array;
    readonly assetsBytes: Uint8Array;
  },
): RemoteAgentRegistry {
  const mobile = owned(state, context);
  if (!mobile.consent.enabled) throw new Error("Separate mobile consent is disabled.");
  const lease = controller(context);
  const host = controllerHost(context);
  const stage = mobile.stages.find((entry) => entry.id === request.id);
  if (
    !stage ||
    stage.phase === "cancelled" ||
    stage.releaseId !== request.releaseId ||
    stage.consentRevision !== context.expectedConsentRevision ||
    !sameController(stage.controller, lease) ||
    JSON.stringify(stage.controllerHost) !== JSON.stringify(host)
  ) {
    throw new Error("Mobile stage completion identity is fenced or conflicting.");
  }
  const release = mobile.releases.find((entry) => entry.id === stage.releaseId);
  if (!release) throw new Error("Mobile stage release is unavailable.");
  const verified = verifiedRelease(context, release.gateway, release.assets);
  if (verified.id !== stage.releaseId) throw new Error("Mobile stage release identity changed.");
  // Verify actual data on every CAS retry, including an idempotent completion retry.
  verifyMobileOptionalArtifactBytes(verified.gateway, request.gatewayBytes);
  verifyMobileOptionalArtifactBytes(verified.assets, request.assetsBytes);
  if (["artifact-bytes-verified", "publication-writing", "files-published"].includes(stage.phase))
    return state;
  return changed(state, {
    ...mobile,
    stages: mobile.stages.map((entry) =>
      entry.id === stage.id ? withPhase(entry, "artifact-bytes-verified") : entry,
    ),
  });
}
