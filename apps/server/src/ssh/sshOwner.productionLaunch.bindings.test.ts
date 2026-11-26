import { describe, expect, it } from "vitest";

import { pickerProofLaunchArgs } from "./sshOwnerPickerProof.client.args.ts";
import type { PickerProofOwnerOptions } from "./sshOwnerPickerProof.client.types.ts";
import { resolveProductionSshConfigPaths } from "./sshOwnerProductionClient.launch.ts";

const base = {
  binary: "/opt/bigbud-ssh-owner",
  lockFile: "/tmp/state/ssh-owner/owner.lock",
  sshBinary: "/usr/bin/ssh",
  keyscanBinary: "/usr/bin/ssh-keyscan",
  profileBinding: Buffer.alloc(32, 1),
  sql: undefined as never,
} satisfies Partial<PickerProofOwnerOptions>;

const production = {
  startupDeadlineMs: 1_000,
  profileBindingText: "bbso1:desktop-dev:01",
  stateDirectory: "/tmp/state",
};

const present = (paths: string[]) => async (path: string) => paths.includes(path);

const argv = (options: Partial<PickerProofOwnerOptions>) =>
  pickerProofLaunchArgs({ ...base, ...options } as PickerProofOwnerOptions, {
    profileBindingHex: "01",
    aliasArgs: [],
    scopedArgs: [],
  });

describe("production owner launch bindings", () => {
  it("asks the owner to discover OpenCode v2 unless a remote override is configured", () => {
    const discover = argv({ productionLaunch: production, opencodeV2Service: {} });
    expect(discover).toContain("--opencode-v2-discover");
    expect(discover).not.toContain("--opencode-v2-service");
    const explicit = argv({
      productionLaunch: production,
      opencodeV2Service: { binaryPath: "/opt/opencode-v2/opencode" },
    });
    expect(explicit[explicit.indexOf("--opencode-v2-service") + 1]).toBe(
      "/opt/opencode-v2/opencode",
    );
    expect(explicit).not.toContain("--opencode-v2-discover");
  });

  it("passes the user's SSH config paths for alias targets, never config text", () => {
    const withConfig = argv({
      productionLaunch: {
        ...production,
        aliasConfig: "/home/u/.ssh/config",
        systemConfig: "/etc/ssh/ssh_config",
      },
    });
    expect(withConfig[withConfig.indexOf("--alias-config") + 1]).toBe("/home/u/.ssh/config");
    expect(withConfig[withConfig.indexOf("--system-config") + 1]).toBe("/etc/ssh/ssh_config");
    expect(argv({ productionLaunch: production })).not.toContain("--alias-config");
  });

  it("resolves only existing SSH config paths, and the system config only beside the user's", async () => {
    await expect(
      resolveProductionSshConfigPaths("/home/u", present(["/home/u/.ssh/config"])),
    ).resolves.toEqual({ aliasConfig: "/home/u/.ssh/config" });
    await expect(
      resolveProductionSshConfigPaths(
        "/home/u",
        present(["/home/u/.ssh/config", "/etc/ssh/ssh_config"]),
      ),
    ).resolves.toEqual({
      aliasConfig: "/home/u/.ssh/config",
      systemConfig: "/etc/ssh/ssh_config",
    });
    await expect(
      resolveProductionSshConfigPaths("/home/u", present(["/etc/ssh/ssh_config"])),
    ).resolves.toEqual({});
  });
});
