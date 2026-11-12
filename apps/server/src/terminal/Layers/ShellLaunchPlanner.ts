import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ShellLaunchPlanner, type ShellLaunchPlannerShape } from "../Services/ShellLaunchPlanner";
import { ShellProfiles, type ShellProfilesShape } from "../Services/ShellProfiles";
import { resolveShellProfileLaunch, ShellProfileResolutionError } from "./ShellProfiles.launch";

export function makeShellLaunchPlanner(profiles: ShellProfilesShape): ShellLaunchPlannerShape {
  return {
    resolveProfile: Effect.fn("ShellLaunchPlanner.resolveProfile")(function* (
      input: Parameters<ShellLaunchPlannerShape["resolveProfile"]>[0],
    ) {
      if (input.selection.kind === "legacy-auto") return null;
      const inventory = yield* profiles.revalidate(input.target);
      return yield* Effect.try({
        try: () =>
          resolveShellProfileLaunch({
            host: inventory.host,
            selection: input.selection,
            profiles: inventory.profiles,
          }),
        catch: (cause) =>
          cause instanceof ShellProfileResolutionError
            ? cause
            : new ShellProfileResolutionError({ reason: "invalid-profile" }),
      });
    }),
  };
}

export const ShellLaunchPlannerLive = Layer.effect(
  ShellLaunchPlanner,
  Effect.gen(function* () {
    return makeShellLaunchPlanner(yield* ShellProfiles);
  }),
);
