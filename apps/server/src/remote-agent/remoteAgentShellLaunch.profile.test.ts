import { describe, expect, it } from "vitest";
import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import { shellProfileId } from "../terminal/Layers/ShellProfiles.identity.ts";
import { resolveShellProfileLaunch } from "../terminal/Layers/ShellProfiles.launch.ts";
import { remoteShellHost } from "../terminal/Layers/ShellProfiles.remote.identity.ts";
import { remoteAgentShellLaunchFromProfile } from "./remoteAgentShellLaunch.profile.ts";
import { remoteAgentPtyRequestDigest } from "./remoteAgentShellLaunch.ts";

const executionTargetId = "ssh:host=example.test&user=alice&transport=direct-ssh";

function resolved(platform: "linux" | "darwin" = "linux") {
  const host = remoteShellHost({ executionTargetId });
  const executable = "/usr/bin/zsh";
  const args = ["-o", "nopromptsp"];
  const profile: TerminalShellProfile = {
    host,
    executable,
    args,
    platform,
    profileId: shellProfileId(host, executable, args, platform),
    kind: "zsh",
    displayName: "zsh",
    availability: "available",
    integration: { status: "unavailable", reason: "not-qualified" },
  };
  return resolveShellProfileLaunch({
    host,
    profiles: [profile],
    selection: { kind: "profile", profileId: profile.profileId },
  })!;
}

const capture = (launch = resolved(), target = executionTargetId, cwd = "/srv/project") =>
  remoteAgentShellLaunchFromProfile({ executionTargetId: target, cwd, launch });

describe("resolved remote shell launch intent", () => {
  it.each(["linux", "darwin"] as const)(
    "retains the exact %s plan without claiming identity",
    (platform) => {
      const launch = resolved(platform);
      const intent = capture(launch);
      expect(intent).toEqual({
        version: 1,
        cwd: "/srv/project",
        requestedProfile: {
          host: launch.identity.host,
          profileId: launch.identity.profileId,
          kind: "zsh",
        },
        executable: "/usr/bin/zsh",
        args: ["-o", "nopromptsp"],
        platform,
        integration: "disabled",
      });
      expect(intent).not.toHaveProperty("shellLaunchIdentity");
      expect(intent).not.toHaveProperty("launchStatus");
    },
  );

  it("copies argv before durable serialization and digest calculation", () => {
    const launch = resolved();
    const intent = capture(launch);
    const digest = remoteAgentPtyRequestDigest({
      target: executionTargetId,
      cwd: intent.cwd,
      shellLaunch: intent,
    });
    (launch.args as string[]).push("unexpected");
    expect(intent.args).toEqual(["-o", "nopromptsp"]);
    expect(
      remoteAgentPtyRequestDigest({
        target: executionTargetId,
        cwd: intent.cwd,
        shellLaunch: intent,
      }),
    ).toEqual(digest);
  });

  it.each([
    "ssh:host=other.test&user=alice&transport=direct-ssh",
    "ssh:host=example.test&user=bob&transport=direct-ssh",
    "ssh:host=example.test&user=alice&port=2222&transport=direct-ssh",
    "local",
    "wsl:Ubuntu",
  ])("rejects a different or unsupported destination %s", (target) => {
    expect(() => capture(resolved(), target)).toThrow();
  });

  it("rejects legacy or inconsistent selections rather than guessing", () => {
    const launch = resolved();
    expect(() =>
      capture({ ...launch, identity: { ...launch.identity, selection: { kind: "legacy-auto" } } }),
    ).toThrow();
    expect(() =>
      capture({
        ...launch,
        identity: { ...launch.identity, selection: { kind: "profile", profileId: "other" } },
      }),
    ).toThrow();
    expect(() => capture({ ...launch, args: [] })).toThrow();
    expect(() => capture({ ...launch, shell: "/bin/bash" })).toThrow();
    expect(() => capture({ ...launch, identity: { ...launch.identity, kind: "bash" } })).toThrow();
  });

  it.each(["relative", "/srv/\nproject", "/srv/\0project"])("rejects invalid cwd %j", (cwd) => {
    expect(() => capture(resolved(), executionTargetId, cwd)).toThrow();
  });
});
