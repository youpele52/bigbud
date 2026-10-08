import { Effect } from "effect";
import type { ServerProvider } from "@bigbud/contracts";
import type { ServerProviderShape } from "../../Services/ServerProvider.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { buildServerProvider } from "../../providerSnapshot.ts";
import { makeProviderSnapshotStore } from "../../providerSnapshot.store.ts";
import { V2_LOCAL_TOOL_LIMITATION } from "./Runtime.policy.ts";
import { normalizeV2Catalog } from "./Catalog.ts";
import { v2Request } from "./Client.ts";
import type { V2DevelopmentConfig } from "./Development.config.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2ProcessLease } from "./ServerManager.ts";
import { assertDevelopmentVersion } from "./Compatibility.ts";
import { setTimeout as delay } from "node:timers/promises";

/** Discovery and execution share one manager/client/hub; lease auth is not model credential proof. */
export const makeV2DevelopmentProvider = Effect.fn("makeV2DevelopmentProvider")(function* (
  runtime: OpencodeV2Runtime,
  config: V2DevelopmentConfig,
  application = false,
) {
  const settings = yield* ServerSettingsService;
  let lease: V2ProcessLease | undefined;
  let pending: Promise<ServerProvider> | undefined;
  let closed = false;
  const probe = async (enabled: boolean): Promise<ServerProvider> => {
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
      assertDevelopmentVersion(info.version);
      const catalog = await v2Request("model.list", async (signal) => {
        // Native location initialization publishes its first catalog asynchronously.
        // Empty is not credential failure; bound this read-only retry and never prompt.
        for (let attempt = 0; ; attempt++) {
          if (closed) throw new Error("V2 discovery is closed.");
          const value = await lease!.process.client.model.list(
            { location: { directory: config.workspace } },
            { signal },
          );
          if (value.data.length || attempt === 4) return value;
          await delay(250, undefined, { signal });
        }
      });
      const models = normalizeV2Catalog(catalog, config.workspace);
      return {
        ...buildServerProvider({
          provider: "opencodeV2",
          enabled,
          checkedAt: new Date().toISOString(),
          models,
          probe: {
            installed: true,
            version: info.version,
            status: "warning",
            auth: { status: "unknown" },
            message: models.length
              ? V2_LOCAL_TOOL_LIMITATION
              : "V2 catalog is empty. Configure providers in the dedicated profile's config/opencode/opencode.jsonc, then refresh.",
          },
        }),
        ...(!application ? { developmentOnly: true } : {}),
        turnControl: {
          nativeSteer: false,
          interruptTarget: "current-session",
          activeTurnInspection: "best-effort",
          continuation: false,
        },
      };
    } catch {
      return {
        ...buildServerProvider({
          provider: "opencodeV2",
          enabled,
          checkedAt: new Date().toISOString(),
          models: [],
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message:
              "V2 readiness failed. Check the absolute executable path, required version 2.0.19, and private owned profile. No fallback was attempted.",
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
