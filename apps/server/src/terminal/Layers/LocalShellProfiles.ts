import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  LocalShellDiscoveryError,
  LocalShellProfiles,
  type LocalShellProfilesShape,
} from "../Services/LocalShellProfiles";
import { LOCAL_SHELL_HOST } from "./ShellProfiles.identity";
import { probeLocalShellProfiles } from "./ShellProfiles.local";

export const LOCAL_SHELL_PROFILE_TTL = "5 minutes";
export const MAX_LOCAL_SHELL_PROFILES = 64;

export const makeLocalShellProfiles = Effect.fn("makeLocalShellProfiles")(function* (
  probe: Effect.Effect<readonly TerminalShellProfile[], LocalShellDiscoveryError>,
): Effect.fn.Return<LocalShellProfilesShape> {
  const revalidate = probe.pipe(
    Effect.flatMap((profiles) => {
      if (
        profiles.length > MAX_LOCAL_SHELL_PROFILES ||
        profiles.some(
          (profile) =>
            profile.host.kind !== "local" || profile.host.hostId !== LOCAL_SHELL_HOST.hostId,
        )
      ) {
        return Effect.fail(new LocalShellDiscoveryError({ reason: "probe-failed" }));
      }
      return Effect.succeed(profiles);
    }),
  );
  const cache = yield* Cache.makeWith({
    capacity: 1,
    lookup: () => revalidate,
    // A failed probe is retryable, not an inventory result or a cached empty list.
    timeToLive: (exit) => (exit._tag === "Success" ? LOCAL_SHELL_PROFILE_TTL : "0 millis"),
  });
  const invalidate = Cache.invalidate(cache, "local");
  return {
    list: Cache.get(cache, "local"),
    invalidate,
    // Executable disappearance during preflight also invalidates the display snapshot.
    revalidate: invalidate.pipe(Effect.andThen(revalidate)),
  };
});

export const LocalShellProfilesLive = Layer.effect(
  LocalShellProfiles,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* makeLocalShellProfiles(
      probeLocalShellProfiles().pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    );
  }),
);
