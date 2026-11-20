import type { MuseSettings, ServerProvider } from "@bigbud/contracts";
import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { Effect, Equal, Layer, Stream } from "effect";

import { makeManagedServerProvider } from "../../makeManagedServerProvider.ts";
import { MuseProvider } from "../../Services/Muse/Provider.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import type { MuseHostFactory, MuseTransport } from "./Client.ts";
import { readMuseUsageLimits } from "./Provider.usageLimits.ts";
import { describeMuseError } from "./Client.errors.ts";
import { closeMuseResources } from "./Adapter.resources.ts";
import { makeSdkMuseHostFactory } from "./Client.lifecycle.ts";
import { discoverMuse, isApiKeyLane, musePlatformGateReason } from "./Provider.discovery.ts";
import {
  MUSE_SUPPORTED_RUNTIME_MODES,
  MUSE_UNSUPPORTED_MODE_REASON,
} from "./Provider.permissions.ts";

export const MUSE_INSTALL_GUIDE_URL = "https://dev.meta.ai/docs/muse-code";

function museSnapshot(input: {
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: ServerProvider["status"];
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
  readonly models?: ServerProvider["models"];
  readonly failure?: ServerProvider["failure"];
  readonly usageLimits?: ServerProviderUsageLimits;
}): ServerProvider {
  return {
    provider: "muse",
    enabled: input.enabled,
    installed: input.installed,
    version: input.version,
    status: input.enabled ? input.status : "disabled",
    auth: input.auth,
    checkedAt: new Date().toISOString(),
    initialProbeComplete: true,
    ...(input.message ? { message: input.message } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
    ...(input.usageLimits ? { usageLimits: input.usageLimits } : {}),
    models: input.models ?? [],
    modelDiscovery: {
      status: input.models && input.models.length > 0 ? "live" : "unavailable",
      source: "muse-msp-catalog",
      durationMs: 0,
    },
    slashCommands: [],
    skills: [],
    supportsLocalRuntimeRemoteWorkspace: false,
    supportsAttachments: false,
    supportsSteer: false,
    supportedRuntimeModes: [...MUSE_SUPPORTED_RUNTIME_MODES],
    supportedInteractionModes: ["default"],
    unsupportedModeReason: MUSE_UNSUPPORTED_MODE_REASON,
    turnControl: {
      nativeSteer: false,
      interruptTarget: "exact-turn",
      activeTurnInspection: "authoritative",
      continuation: false,
    },
  };
}

export function initialMuseSnapshot(settings: MuseSettings): ServerProvider {
  if (!settings.enabled) {
    return museSnapshot({
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      message: `Muse Code is disabled in bigbud settings. Install Muse, run \`muse\` in a terminal and sign in with your browser, then enable it. Setup: ${MUSE_INSTALL_GUIDE_URL}`,
    });
  }
  return museSnapshot({
    enabled: true,
    installed: true,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: "Checking Muse Code availability...",
  });
}

export const checkMuseProviderStatus = (
  settings: MuseSettings,
  factory: MuseHostFactory,
  platform: NodeJS.Platform = process.platform,
  /** Reads subscription limits on the open discovery host; omitted in tests. */
  readUsage?: (transport: MuseTransport) => Promise<ServerProviderUsageLimits>,
) =>
  Effect.promise(async (): Promise<ServerProvider> => {
    if (!settings.enabled) return initialMuseSnapshot(settings);
    let transport;
    try {
      transport = await factory({ binaryPath: settings.binaryPath, cwd: process.cwd() });
    } catch (error) {
      const detail = describeMuseError(error);
      const missing = /enoent|not found|no such file/i.test(detail);
      return museSnapshot({
        enabled: true,
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `Muse CLI (\`${settings.binaryPath}\`) is not installed or not on PATH. Install it and sign in by running \`muse\` in a terminal: ${MUSE_INSTALL_GUIDE_URL}`
          : `Muse host failed to start: ${detail.slice(0, 240)}`,
        failure: {
          classification: "user-action-required",
          reason: missing ? "command-not-found" : "process-failed",
        },
      });
    }
    try {
      const discovery = await discoverMuse(transport);
      const gate = musePlatformGateReason(platform);
      if (isApiKeyLane(discovery.authType)) {
        return museSnapshot({
          enabled: true,
          installed: true,
          version: discovery.version ?? null,
          status: "warning",
          auth: { status: "unknown", type: discovery.authType },
          models: discovery.models,
          message:
            "An API key (META_API_KEY or a stored Muse API key) is taking precedence over browser sign-in. bigbud Muse uses your native browser login only; remove the key override and run `muse` in a terminal to sign in.",
        });
      }
      if (discovery.gateFailure) {
        return museSnapshot({
          enabled: true,
          installed: true,
          version: discovery.version ?? null,
          status: "warning",
          auth: { status: discovery.authStatus },
          models: discovery.models,
          message: discovery.gateFailure,
        });
      }
      const usageLimits = readUsage ? await readUsage(transport) : undefined;
      return museSnapshot({
        enabled: true,
        installed: true,
        version: discovery.version ?? null,
        ...(usageLimits ? { usageLimits } : {}),
        // A valid but empty native catalog is not usable. Keep discovery
        // unavailable instead of claiming readiness without selectable models.
        status:
          gate || discovery.authStatus !== "authenticated" || discovery.models.length === 0
            ? "warning"
            : "ready",
        auth: {
          status: discovery.authStatus,
          ...(discovery.authType ? { type: discovery.authType } : {}),
        },
        models: discovery.models,
        ...(discovery.models.length === 0
          ? {
              message:
                "Muse returned an empty model catalog. No verified models are available. Check model availability in the native `muse` CLI, then refresh provider status. bigbud will not substitute unverified models.",
            }
          : {}),
        ...(gate ? { message: gate } : {}),
        ...(discovery.authStatus === "unauthenticated"
          ? {
              message:
                "Muse is not signed in. Run `muse` in a terminal and complete browser sign-in; bigbud never signs in for you.",
            }
          : {}),
      });
    } catch (error) {
      const detail = describeMuseError(error);
      return museSnapshot({
        enabled: true,
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Muse discovery failed: ${detail.slice(0, 240)}`,
        failure: { classification: "retryable", reason: "process-failed" },
      });
    } finally {
      await closeMuseResources([() => transport.close()]);
    }
  });

export const makeMuseProviderLive = (factory: MuseHostFactory = makeSdkMuseHostFactory()) =>
  Layer.effect(
    MuseProvider,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      return yield* makeManagedServerProvider<MuseSettings>({
        getSettings: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providers.muse),
          Effect.orDie,
        ),
        streamSettings: serverSettings.streamChanges.pipe(
          Stream.map((settings) => settings.providers.muse),
        ),
        haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
        initialSnapshot: initialMuseSnapshot,
        checkProvider: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providers.muse),
          Effect.flatMap((settings) =>
            checkMuseProviderStatus(settings, factory, process.platform, (transport) =>
              readMuseUsageLimits({ settings, transport, hostFactory: factory }),
            ),
          ),
        ),
        readUsageLimits: (settings) =>
          Effect.promise(() => readMuseUsageLimits({ settings, hostFactory: factory })),
      });
    }),
  );

export const MuseProviderLive = makeMuseProviderLive();
