import type {
  ShellHostScope,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { ShellProfileDiscoveryError, type ShellProfilesShape } from "../Services/ShellProfiles";
import { shellProfileId } from "./ShellProfiles.identity";
import { makeShellLaunchPlanner } from "./ShellLaunchPlanner";

const hosts: readonly ShellHostScope[] = [
  { kind: "local", hostId: "local" },
  { kind: "ssh", hostId: "ssh-account" },
  { kind: "wsl", hostId: "wsl-account", distribution: "Ubuntu", username: "dev" },
];
const target = { executionTargetId: "local" };
function profile(host: ShellHostScope): TerminalShellProfile {
  const executable = "/opt/homebrew/bin/zsh";
  const args = ["-o", "nopromptsp"];
  return {
    profileId: shellProfileId(host, executable, args, "linux"),
    host,
    kind: "zsh",
    displayName: "Zsh",
    executable,
    args,
    platform: "linux",
    availability: "available",
    integration: { status: "unavailable", reason: "not-qualified" },
  };
}
function inventoryService(revalidate: ShellProfilesShape["revalidate"]): ShellProfilesShape {
  return {
    list: () => Effect.die("launch must not use cached display inventory"),
    invalidate: () => Effect.void,
    revalidate,
  };
}

describe("execution-host shell profile launch planner", () => {
  for (const host of hosts) {
    it(`preserves exact ${host.kind} executable/argv and host identity from fresh inventory`, async () => {
      const selected = profile(host);
      let calls = 0;
      const planner = makeShellLaunchPlanner(
        inventoryService((input) => {
          expect(input).toBe(target);
          calls++;
          return Effect.succeed({ host, profiles: [selected] });
        }),
      );
      const launch = await Effect.runPromise(
        planner.resolveProfile({
          target,
          selection: { kind: "profile", profileId: selected.profileId },
        }),
      );
      expect(calls).toBe(1);
      expect(launch).toEqual({
        shell: selected.executable,
        args: selected.args,
        platform: selected.platform,
        dropPathMode: "posix",
        identity: {
          host,
          selection: { kind: "profile", profileId: selected.profileId },
          profileId: selected.profileId,
          kind: "zsh",
          integration: { status: "unavailable", reason: "not-qualified" },
        },
      });
      expect(launch?.args).not.toBe(selected.args);
    });
  }

  it("leaves legacy paths unchanged without discovery, including old agents", async () => {
    const planner = makeShellLaunchPlanner(
      inventoryService(() => Effect.die("legacy must not discover")),
    );
    expect(
      await Effect.runPromise(
        planner.resolveProfile({
          target: { executionTargetId: "remote-agent:old-agent" },
          selection: { kind: "legacy-auto" },
        }),
      ),
    ).toBeNull();
  });

  it("does not resolve a selected profile against another execution host", async () => {
    const selected = profile(hosts[1]!);
    const planner = makeShellLaunchPlanner(
      inventoryService(() => Effect.succeed({ host: hosts[0]!, profiles: [selected] })),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        planner.resolveProfile({
          target,
          selection: { kind: "profile", profileId: selected.profileId },
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "ShellProfileResolutionError",
      reason: "missing-profile",
    });
  });

  it("fails visibly when the profile disappears between display and launch", async () => {
    const selected = profile(hosts[0]!);
    let available = true;
    const planner = makeShellLaunchPlanner(
      inventoryService(() =>
        Effect.succeed({ host: selected.host, profiles: available ? [selected] : [] }),
      ),
    );
    const request = {
      target,
      selection: { kind: "profile", profileId: selected.profileId },
    } as const;
    expect(await Effect.runPromise(planner.resolveProfile(request))).not.toBeNull();
    available = false;
    expect(await Effect.runPromise(Effect.flip(planner.resolveProfile(request)))).toMatchObject({
      _tag: "ShellProfileResolutionError",
      reason: "missing-profile",
    });
  });

  it("propagates discovery failure rather than returning a legacy plan", async () => {
    const planner = makeShellLaunchPlanner(
      inventoryService(() => Effect.fail(new ShellProfileDiscoveryError({ reason: "timed-out" }))),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        planner.resolveProfile({ target, selection: { kind: "profile", profileId: "missing" } }),
      ),
    );
    expect(error).toMatchObject({ _tag: "ShellProfileDiscoveryError", reason: "timed-out" });
  });
});
