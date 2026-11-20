import { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { isLocalExecutionTarget } from "../../executionTargets";
import { LocalShellProfiles, type LocalShellProfilesShape } from "../Services/LocalShellProfiles";
import {
  ShellProfileDiscoveryError,
  ShellProfiles,
  type ShellProfileInventory,
  type ShellProfilesShape,
  type ShellProfileTarget,
} from "../Services/ShellProfiles";
import { LOCAL_SHELL_HOST } from "./ShellProfiles.identity";
import { sameShellHost } from "./ShellProfiles.launch";
import { discoverRemoteShellProfiles } from "./ShellProfiles.remote";
import { remoteShellHost } from "./ShellProfiles.remote.identity";

export const SHELL_PROFILE_TTL = "5 minutes";
export const MAX_SHELL_PROFILE_HOSTS = 32;
export const MAX_SHELL_PROFILES = 64;

type RemoteDiscovery = (
  target: ShellProfileTarget,
) => Effect.Effect<
  readonly TerminalShellProfile[],
  { readonly reason: "probe-failed" | "timed-out" | "unsupported-target" }
>;
const discoveryError = (cause: { readonly reason: ShellProfileDiscoveryError["reason"] }) =>
  new ShellProfileDiscoveryError({ reason: cause.reason });

// Cache keys use value equality and copy the pinned identity. UID participates even though
// profile IDs use the account name: an account recreated under a new UID needs a fresh probe.
class WslCacheIdentity extends Data.Class<NonNullable<ShellProfileTarget["wslIdentity"]>> {}
class InventoryCacheKey extends Data.Class<ShellProfileTarget> {}

function cacheKey(target: ShellProfileTarget): InventoryCacheKey {
  return new InventoryCacheKey({
    executionTargetId: target.executionTargetId,
    ...(target.wslIdentity ? { wslIdentity: new WslCacheIdentity({ ...target.wslIdentity }) } : {}),
  });
}

const inventoryHost = (target: ShellProfileTarget) =>
  Effect.try({
    try: () => {
      if (!isLocalExecutionTarget(target.executionTargetId)) return remoteShellHost(target);
      if (target.wslIdentity) throw new Error("invalid local identity");
      return LOCAL_SHELL_HOST;
    },
    catch: () => new ShellProfileDiscoveryError({ reason: "unsupported-target" }),
  });

const validateInventory = Effect.fn("ShellProfiles.validateInventory")(function* (
  host: ShellProfileInventory["host"],
  profiles: readonly TerminalShellProfile[],
) {
  if (profiles.length > MAX_SHELL_PROFILES) {
    return yield* new ShellProfileDiscoveryError({ reason: "probe-failed" });
  }
  const validated = yield* Schema.decodeUnknownEffect(Schema.Array(TerminalShellProfile))(
    profiles,
  ).pipe(Effect.mapError(() => new ShellProfileDiscoveryError({ reason: "probe-failed" })));
  if (
    validated.some((profile) => !sameShellHost(host, profile.host)) ||
    new Set(validated.map((profile) => profile.profileId)).size !== validated.length
  ) {
    return yield* new ShellProfileDiscoveryError({ reason: "probe-failed" });
  }
  return { host, profiles: validated } satisfies ShellProfileInventory;
});

export const makeShellProfiles = Effect.fn("makeShellProfiles")(function* (
  local: LocalShellProfilesShape,
  discoverRemote: RemoteDiscovery = discoverRemoteShellProfiles,
): Effect.fn.Return<ShellProfilesShape> {
  const probeRemote = Effect.fn("ShellProfiles.probeRemote")(function* (
    target: ShellProfileTarget,
  ) {
    const host = yield* inventoryHost(target);
    const profiles = yield* discoverRemote(target).pipe(Effect.mapError(discoveryError));
    return yield* validateInventory(host, profiles);
  });
  const cache = yield* Cache.makeWith({
    capacity: MAX_SHELL_PROFILE_HOSTS,
    lookup: probeRemote,
    timeToLive: (exit) => (exit._tag === "Success" ? SHELL_PROFILE_TTL : "0 millis"),
  });
  return {
    list: Effect.fn("ShellProfiles.list")(function* (target: ShellProfileTarget) {
      const host = yield* inventoryHost(target);
      if (host.kind !== "local") return yield* Cache.get(cache, cacheKey(target));
      const profiles = yield* local.list.pipe(Effect.mapError(discoveryError));
      return yield* validateInventory(host, profiles);
    }),
    invalidate: Effect.fn("ShellProfiles.invalidate")(function* (target: ShellProfileTarget) {
      const host = yield* inventoryHost(target);
      if (host.kind === "local") return yield* local.invalidate;
      yield* Cache.invalidate(cache, cacheKey(target));
    }),
    revalidate: Effect.fn("ShellProfiles.revalidate")(function* (target: ShellProfileTarget) {
      const host = yield* inventoryHost(target);
      if (host.kind === "local") {
        const profiles = yield* local.revalidate.pipe(Effect.mapError(discoveryError));
        return yield* validateInventory(host, profiles);
      }
      const key = cacheKey(target);
      yield* Cache.invalidate(cache, key);
      return yield* probeRemote(key);
    }),
  };
});

export const ShellProfilesLive = Layer.effect(
  ShellProfiles,
  Effect.gen(function* () {
    const local = yield* LocalShellProfiles;
    return yield* makeShellProfiles(local);
  }),
);
