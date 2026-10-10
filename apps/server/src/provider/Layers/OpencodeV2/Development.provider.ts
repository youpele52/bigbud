import { Effect } from "effect";
import type { ServerProvider } from "@bigbud/contracts";
import type { ServerProviderShape } from "../../Services/ServerProvider.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { buildServerProvider } from "../../providerSnapshot.ts";
import { makeProviderSnapshotStore } from "../../providerSnapshot.store.ts";
import { V2_LOCAL_TOOL_LIMITATION } from "./Runtime.policy.ts";
import { normalizeV2Catalog } from "./Catalog.ts";
import { makeV2PublicCatalogLoader, mergeV2Catalogs } from "./Catalog.public.ts";
import { readV2NativeCatalog } from "./Catalog.native.ts";
import { v2Request } from "./Client.ts";
import type { V2DevelopmentConfig } from "./Development.config.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2ProcessLease } from "./ServerManager.ts";
import { assertDevelopmentVersion, OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
import {
  assertV2SharedQualifiedVersion,
  V2_RECOMMENDED_RUNTIME_VERSION,
} from "./SharedService.compatibility.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";

/** Discovery and execution share one manager/client/hub; lease auth is not model credential proof. */
export const makeV2DevelopmentProvider = Effect.fn("makeV2DevelopmentProvider")(function* (
  runtime: OpencodeV2Runtime,
  config: V2DevelopmentConfig,
  application = false,
  loadPublicCatalog = makeV2PublicCatalogLoader(),
) {
  const settings = yield* ServerSettingsService;
  let lease: V2ProcessLease | undefined;
  let pending: Promise<ServerProvider> | undefined;
  let closed = false;
  let lastModels: ServerProvider["models"] = [];
  const probe = async (enabled: boolean): Promise<ServerProvider> => {
    const started = performance.now();
    let version: string | undefined;
    try {
      if (closed) throw new Error("V2 discovery is closed.");
      if (lease && !lease.process.isRunning()) {
        await lease.release();
        lease = undefined;
      }
      lease ??= await runtime.options.manager.acquire(config.process);
      if (closed) {
        await lease.release();
        lease = undefined;
        throw new Error("V2 late discovery disposed.");
      }
      const info = await v2Request("server.info", (signal) =>
        lease!.process.client.server.info({ signal }),
      );
      version = info.version;
      if (config.process.sharedService) assertV2SharedQualifiedVersion(info.version);
      else assertDevelopmentVersion(info.version);
      const catalog = await readV2NativeCatalog(lease.process.client, config.workspace, {
        isClosed: () => closed,
      });
      const providers = await v2Request("provider.list", (signal) =>
        lease!.process.client.provider.list(
          { location: { directory: config.workspace } },
          { signal },
        ),
      );
      const nativeModels = normalizeV2Catalog(catalog, config.workspace, providers);
      const shared = Boolean(config.process.sharedService);
      const integrations = shared
        ? await v2Request("integration.list", (signal) =>
            lease!.process.client.integration.list(
              { location: { directory: config.workspace } },
              { signal },
            ),
          )
        : undefined;
      const connected = integrations?.data.filter((integration) =>
        integration.connections.some((connection) => connection.status?.status !== "needs_auth"),
      );
      const agents = shared
        ? await v2Request("agent.list", (signal) =>
            lease!.process.client.agent.list(
              { location: { directory: config.workspace } },
              { signal },
            ),
          )
        : undefined;
      const skills = shared
        ? await v2Request("skill.list", (signal) =>
            lease!.process.client.skill.list(
              { location: { directory: config.workspace } },
              { signal },
            ),
          )
        : undefined;
      if (
        (agents?.data.length ?? 0) > 1000 ||
        (skills?.data.length ?? 0) > 2000 ||
        (integrations?.data.length ?? 0) > 1000
      )
        throw new Error("V2 native inventory bound exceeded.");
      const publicCatalog = await loadPublicCatalog();
      const models = mergeV2Catalogs(
        publicCatalog.models,
        nativeModels,
        new Map(providers.data.map(({ id, name }) => [id, name])),
      );
      lastModels = models;
      const catalogMessage = publicCatalog.stale
        ? "Full catalog refresh failed; showing the last good catalog and current native models. Retry after 30 seconds. "
        : "";
      return {
        ...buildServerProvider({
          provider: "opencodeV2",
          enabled,
          checkedAt: new Date().toISOString(),
          models,
          probe: {
            installed: true,
            version: info.version,
            status: shared && nativeModels.length ? "ready" : "warning",
            auth: connected?.length
              ? {
                  status: "authenticated",
                  label: connected
                    .map(({ name }) => name)
                    .slice(0, 4)
                    .join(", "),
                }
              : { status: "unknown" },
            message: shared
              ? nativeModels.length
                ? "Connected to your native OpenCode service."
                : "No native models are available. Connect a provider in OpenCode; bigbud detects account changes automatically."
              : `${catalogMessage}Configure a provider in the isolated profile; accounts are not verified by browsing. ${V2_LOCAL_TOOL_LIMITATION}`,
          },
        }),
        ...(!application ? { developmentOnly: true } : {}),
        ...(shared ? { supportsLocalRuntimeRemoteWorkspace: false } : {}),
        ...(shared && info.version === "2.0.24"
          ? { runtimeUpdateRecommended: V2_RECOMMENDED_RUNTIME_VERSION }
          : {}),
        ...(agents
          ? {
              nativeAgents: agents.data
                .filter(({ hidden }) => !hidden)
                .map(({ id, name, description }) => ({
                  id,
                  name,
                  ...(description ? { description } : {}),
                })),
            }
          : {}),
        ...(skills
          ? {
              skills: skills.data.map(({ name, path, description }) => ({
                name,
                path,
                enabled: true,
                ...(description ? { description } : {}),
              })),
            }
          : {}),
        modelDiscovery: {
          status: publicCatalog.stale ? "unavailable" : "live",
          source: "opencode-v2-native+models.opencode.ai",
          version: info.version,
          durationMs: Math.round(performance.now() - started),
        },
        turnControl: {
          nativeSteer: false,
          interruptTarget: "current-session",
          activeTurnInspection: "best-effort",
          continuation: false,
        },
      };
    } catch (error) {
      if (version && !lastModels.length) lastModels = (await loadPublicCatalog()).models;
      return {
        ...buildServerProvider({
          provider: "opencodeV2",
          enabled,
          checkedAt: new Date().toISOString(),
          models: lastModels.map((model) => ({
            ...model,
            availability: "requires-setup" as const,
          })),
          probe: {
            installed: version !== undefined,
            version:
              version ?? (error instanceof V2SharedServiceError ? (error.version ?? null) : null),
            status: "warning",
            auth: { status: "unknown" },
            message: config.process.sharedService
              ? "Shared OpenCode v2 connection is unavailable. Check the native TUI service; no history was rebound or resent."
              : `V2 readiness failed. Check the executable, qualified private runtime ${OPENCODE_V2_CLIENT_VERSION}, and isolated profile. No fallback was attempted.`,
          },
        }),
        ...(!application ? { developmentOnly: true } : {}),
      };
    }
  };
  const isEnabled = settings.getSettings.pipe(
    Effect.map((value) => value.providers.opencodeV2.enabled),
    Effect.orElseSucceed(() => false),
  );
  const disabledSnapshot = () => ({
    ...buildServerProvider({
      provider: "opencodeV2" as const,
      enabled: false,
      checkedAt: new Date().toISOString(),
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode v2 is disabled in bigbud settings.",
      },
    }),
    ...(!application ? { developmentOnly: true } : {}),
  });
  const initiallyEnabled = yield* isEnabled;
  const snapshots = yield* makeProviderSnapshotStore(
    initiallyEnabled
      ? {
          ...disabledSnapshot(),
          enabled: true,
          status: "warning",
          initialProbeComplete: false,
          message: "Checking OpenCode v2 availability...",
        }
      : disabledSnapshot(),
  );
  const refresh = Effect.gen(function* () {
    const enabled = yield* isEnabled;
    let snapshot: ServerProvider = enabled
      ? yield* Effect.promise(() => {
          pending ??= probe(enabled).finally(() => {
            pending = undefined;
          });
          return pending;
        })
      : disabledSnapshot();
    if (!(yield* isEnabled)) snapshot = disabledSnapshot();
    yield* snapshots.publish(snapshot);
    return snapshot;
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;
      await pending;
      await lease?.release();
      lease = undefined;
    }),
  );
  if (initiallyEnabled && !application) yield* refresh.pipe(Effect.forkScoped);
  return {
    getSnapshot: snapshots.getSnapshot,
    refresh,
    refreshWithRecovery: () => refresh,
    streamChanges: snapshots.streamChanges,
  } satisfies ServerProviderShape;
});
