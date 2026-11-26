import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionShellProfiles } from "./ShellProfiles.sshOwner.ts";

const target = { executionTargetId: "ssh:host=10.0.0.5&user=dev&transport=direct-ssh" };

function owner(shells: ReadonlyArray<string>) {
  const listTerminalShells = vi.fn(async () => shells);
  return {
    listTerminalShells,
    read: () =>
      ({
        handle: { target: () => ({ listTerminalShells }), ownerEpoch: new Uint8Array(32) },
        descriptorFor: async () => ({ targetId: target.executionTargetId }),
      }) as unknown as SshOwnerProductionRegistration,
  };
}

describe("U16 production shell profiles", () => {
  it("lists the owner's /etc/shells and launches only a listed path", async () => {
    const live = owner(["/bin/bash", "/usr/bin/zsh"]);
    const shells = makeProductionShellProfiles(live.read);
    const inventory = await Effect.runPromise(shells.list(target));
    expect(inventory.host.kind).toBe("ssh");
    expect(inventory.profiles.map((profile) => [profile.kind, profile.executable])).toEqual([
      ["bash", "/bin/bash"],
      ["zsh", "/usr/bin/zsh"],
    ]);
    const zsh = inventory.profiles[1]!;
    const launch = await Effect.runPromise(
      shells.resolve({ kind: "profile", profileId: zsh.profileId }, target),
    );
    expect(launch).toMatchObject({ shell: "/usr/bin/zsh", args: [] });
    expect(shells.shellFor({ shellProfile: launch!.identity } as never)).toBe("/usr/bin/zsh");
    expect(shells.shellFor({ shellProfile: { profileId: "shell:v1:unknown" } } as never)).toBe(
      undefined,
    );
    expect(await Effect.runPromise(shells.resolve({ kind: "legacy-auto" }, target))).toBeNull();
  });

  it("refuses an unknown profile and a dead owner typed", async () => {
    const shells = makeProductionShellProfiles(owner(["/bin/sh"]).read);
    expect(
      await Effect.runPromise(
        Effect.flip(shells.resolve({ kind: "profile", profileId: "shell:v1:missing" }, target)),
      ),
    ).toMatchObject({ _tag: "ShellProfileResolutionError", reason: "missing-profile" });
    const dead = makeProductionShellProfiles(() => undefined);
    expect(await Effect.runPromise(Effect.flip(dead.list(target)))).toMatchObject({
      _tag: "ShellProfileDiscoveryError",
      reason: "probe-failed",
    });
  });
});
