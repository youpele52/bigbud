import { describe, expect, it } from "vitest";
import { remoteAgentOwnedPtyLaunch } from "./remoteAgentOwnedPty.launch.ts";
import { parseRemoteAgentOwner } from "./remoteAgentOwners.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import {
  localSupervisorTarget,
  localSupervisorShellHost,
} from "../remote-backend/localSupervisorIdentity.ts";
import { localSupervisorLaunch } from "../remote-backend/localSupervisorLaunch.ts";
import {
  profileLaunch,
  profileOwner,
  spawnInput,
  target,
} from "./remoteAgentOwnedPty.profile.testUtils.ts";

describe("durable terminal requested launch resolution", () => {
  it("requires a trusted agent-host resolver for a backend-local profile and restores only its stored intent", () => {
    const targetId = localSupervisorTarget("a".repeat(32));
    const local = {
      ...spawnInput(),
      cwd: "/srv/project",
      remoteCwd: "/srv/project",
      executionTargetId: targetId,
      shell: "/bin/bash",
      args: ["--noprofile"],
    };
    const launch = localSupervisorLaunch(local, targetId);
    const request = { ...local, shellLaunch: launch };
    expect(() => remoteAgentOwnedPtyLaunch(request)).toThrow();
    const prepared = remoteAgentOwnedPtyLaunch(request, undefined, localSupervisorShellHost);
    const owner = parseRemoteAgentOwner(
      JSON.stringify({
        ...profileOwner(),
        target: targetId,
        terminalCwd: local.cwd,
        shellLaunch: launch,
        digest: prepared.digest,
      }),
    );
    expect(remoteAgentOwnedPtyLaunch(local, owner, localSupervisorShellHost)).toEqual(prepared);
    expect(() =>
      remoteAgentOwnedPtyLaunch(
        { ...request, executionTargetId: localSupervisorTarget("b".repeat(32)) },
        owner,
        localSupervisorShellHost,
      ),
    ).toThrow();
    expect(() =>
      remoteAgentOwnedPtyLaunch(request, undefined, () => ({
        kind: "agent",
        hostId: "another-authority",
      })),
    ).toThrow("another execution host");
  });

  it("keeps the legacy target/cwd digest byte-for-byte unchanged", () => {
    const input = spawnInput();
    expect(remoteAgentOwnedPtyLaunch(input)).toEqual({
      digest: Buffer.from(remoteAgentRequestDigest({ target, cwd: input.remoteCwd })).toString(
        "hex",
      ),
    });
  });

  it("captures exact requested intent before reservation without claiming actual identity", () => {
    const launch = profileLaunch();
    const resolved = remoteAgentOwnedPtyLaunch(spawnInput(launch));
    expect(resolved.shellLaunch).toEqual(launch);
    expect(resolved.shellLaunch?.args).not.toBe(launch.args);
    expect(resolved).not.toHaveProperty("shellLaunchIdentity");
    expect(resolved).not.toHaveProperty("launchStatus");
    const persisted = parseRemoteAgentOwner(JSON.stringify(profileOwner(resolved.shellLaunch)));
    expect(persisted.digest).toBe(resolved.digest);
    expect(persisted.shellLaunch).toEqual(launch);
  });

  it.each(["prepared", "may-have-been-sent", "outcome-unknown"] as const)(
    "restores %s intent even when no profile was supplied by the caller",
    (state) => {
      const owner = { ...profileOwner(profileLaunch()), state };
      expect(remoteAgentOwnedPtyLaunch(spawnInput(), owner)).toEqual({
        digest: owner.digest,
        shellLaunch: owner.shellLaunch,
      });
    },
  );

  it("never upgrades a legacy owner to a newly requested profile", () => {
    expect(() => remoteAgentOwnedPtyLaunch(spawnInput(profileLaunch()), profileOwner())).toThrow(
      "conflicts",
    );
    expect(remoteAgentOwnedPtyLaunch(spawnInput(), profileOwner())).not.toHaveProperty(
      "shellLaunch",
    );
  });

  it("rejects changed profile, host, target, cwd, or digest for a live/unknown owner", () => {
    const owner = profileOwner(profileLaunch());
    const changed = { ...profileLaunch(), executable: "/bin/zsh" };
    expect(() => remoteAgentOwnedPtyLaunch(spawnInput(changed), owner)).toThrow();
    expect(() =>
      remoteAgentOwnedPtyLaunch({ ...spawnInput(), remoteCwd: "/other" }, owner),
    ).toThrow();
    expect(() =>
      remoteAgentOwnedPtyLaunch(
        { ...spawnInput(), executionTargetId: "ssh:host=other&user=alice" },
        owner,
      ),
    ).toThrow();
    expect(() =>
      remoteAgentOwnedPtyLaunch(spawnInput(), { ...owner, digest: "b".repeat(64) }),
    ).toThrow();
    expect(() =>
      remoteAgentOwnedPtyLaunch(spawnInput(), { ...owner, target: "ssh:other" }),
    ).toThrow();
  });

  it("accepts an identical explicit choice but does not inherit uncertain intent after exit", () => {
    const owner = profileOwner(profileLaunch());
    expect(remoteAgentOwnedPtyLaunch(spawnInput(profileLaunch()), owner).digest).toBe(owner.digest);
    expect(
      remoteAgentOwnedPtyLaunch(spawnInput(), { ...owner, state: "terminal" }),
    ).not.toHaveProperty("shellLaunch");
  });

  it("rejects cross-account intent before reservation even for a brand new owner", () => {
    expect(() =>
      remoteAgentOwnedPtyLaunch({
        ...spawnInput(profileLaunch()),
        executionTargetId: "ssh:host=example.test&user=bob",
      }),
    ).toThrow("another execution host");
    expect(() =>
      remoteAgentOwnedPtyLaunch({ ...spawnInput(profileLaunch()), remoteCwd: "/other" }),
    ).toThrow("cwd");
    expect(() => remoteAgentOwnedPtyLaunch({ ...spawnInput(), executionTargetId: "" })).toThrow();
  });
});
