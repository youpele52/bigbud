import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import { LocalShellProfiles } from "../Services/LocalShellProfiles";
import { ShellLaunchPlanner } from "../Services/ShellLaunchPlanner";
import { ShellProfiles } from "../Services/ShellProfiles";
import { ShellLaunchPlannerLive } from "./ShellLaunchPlanner";
import { ShellProfilesLive } from "./ShellProfiles";
import { LOCAL_SHELL_HOST, shellProfileId } from "./ShellProfiles.identity";

const profile: TerminalShellProfile = {
  host: LOCAL_SHELL_HOST,
  profileId: shellProfileId(LOCAL_SHELL_HOST, "/bin/bash", [], "linux"),
  executable: "/bin/bash",
  args: [],
  displayName: "Bash",
  kind: "bash",
  platform: "linux",
  availability: "available",
  integration: { status: "unavailable", reason: "not-qualified" },
};

describe("production shell planner service composition", () => {
  it("resolves through live planner and host inventory layers using fresh local discovery", async () => {
    let freshProbes = 0;
    const layer = ShellLaunchPlannerLive.pipe(
      Layer.provideMerge(ShellProfilesLive),
      Layer.provide(
        Layer.succeed(LocalShellProfiles, {
          list: Effect.die("launch must not read the display cache"),
          invalidate: Effect.void,
          revalidate: Effect.sync(() => {
            freshProbes++;
            return [profile];
          }),
        }),
      ),
    );
    const launch = await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* ShellLaunchPlanner;
        // TerminalManager consumes the inventory service as well as the planner.
        const profiles = yield* ShellProfiles;
        yield* profiles.invalidate({ executionTargetId: "local" });
        const legacy = yield* planner.resolveProfile({
          target: { executionTargetId: "local" },
          selection: { kind: "legacy-auto" },
        });
        expect(legacy).toBeNull();
        expect(freshProbes).toBe(0);
        return yield* planner.resolveProfile({
          target: { executionTargetId: "local" },
          selection: { kind: "profile", profileId: profile.profileId },
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(freshProbes).toBe(1);
    expect(launch?.shell).toBe("/bin/bash");
    expect(launch?.identity.host).toEqual(LOCAL_SHELL_HOST);
    expect(launch?.identity.selection).toEqual({ kind: "profile", profileId: profile.profileId });
  });
});
