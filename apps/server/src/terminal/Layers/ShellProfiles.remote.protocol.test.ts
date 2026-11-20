import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import { shellProfileId } from "./ShellProfiles.identity";
import {
  decodeRemoteShellInventory,
  REMOTE_SHELL_OUTPUT_BYTES,
} from "./ShellProfiles.remote.protocol";
import { inventory } from "./ShellProfiles.remote.test.helpers";

const host = { kind: "ssh", hostId: "opaque-host" } as const;
const decode = (raw: string) => decodeRemoteShellInventory(raw, host);

describe("remote shell inventory decoder", () => {
  it("preserves spaces and Unicode, fixed zsh args, basename labels and exact contract", () => {
    const executable = "/physical shells/日本語/zsh";
    const profiles = decode(inventory([["/bin/zsh", executable]]));
    expect(profiles).toEqual([
      {
        profileId: shellProfileId(host, executable, ["-o", "nopromptsp"], "linux"),
        host,
        kind: "zsh",
        displayName: "zsh",
        executable,
        args: ["-o", "nopromptsp"],
        platform: "linux",
        availability: "available",
        integration: { status: "unavailable", reason: "not-qualified" },
      },
    ]);
    expect(Schema.is(TerminalShellProfile)(profiles[0])).toBe(true);
  });

  it("deduplicates physical directory aliases deterministically and retains shell kinds", () => {
    const raw = inventory([
      ["/bin/bash", "/usr/bin/bash"],
      ["/usr/bin/bash", "/usr/bin/bash"],
      ["/bin/sh", "/usr/bin/sh"],
      ["/bin/pwsh", "/usr/bin/pwsh"],
    ]);
    expect(decode(raw)).toHaveLength(3);
    expect(decode(raw).map((profile) => [profile.displayName, profile.kind, profile.args])).toEqual(
      [
        ["bash", "bash", []],
        ["sh", "other", []],
        ["pwsh", "pwsh", []],
      ],
    );
    expect(decode(raw)).toEqual(decode(raw));
  });

  it("accepts only a complete successful empty frame", () => {
    expect(decode(inventory([]))).toEqual([]);
    expect(() => decode("")).toThrow();
  });

  it.each([
    "relative/zsh",
    "C:\\shells\\zsh",
    "//server/zsh",
    "/bin/../zsh",
    "/bin/./zsh",
    "/bin//zsh",
    "/bin/bash",
    "/bin/zsh/",
    "/with\nnewline/zsh",
    "/with\rreturn/zsh",
    "/with\t tab/zsh",
    "/with\x1bescape/zsh",
    "/with\x85control/zsh",
    "/with\u2028separator/zsh",
    "/with\uFFFDreplacement/zsh",
    "/with\uD800surrogate/zsh",
    `/${"a".repeat(4096)}/zsh`,
  ])("rejects unsafe executable path %j", (executable) => {
    expect(() => decode(inventory([["/bin/zsh", executable]]))).toThrow();
  });

  it.each([
    () => "banner\n" + inventory(),
    () => "﻿" + inventory(),
    () => "\0" + inventory(),
    () => inventory() + "banner\n",
    () => inventory() + inventory(),
    () => inventory().slice(0, -1),
    () => inventory().slice(0, -10),
    () => inventory().replace("zsh\0end-shell", "zsh\0extra\0end-shell"),
    () => inventory().replace("inventory-v1", "inventory-v2"),
    () => inventory([["/workspace/zsh", "/workspace/zsh"]]),
    () => inventory([["/bin/zsh", "/with\0nul/zsh"]]),
    () =>
      inventory([
        ["/bin/zsh", "/bin/zsh"],
        ["/bin/zsh", "/bin/zsh"],
      ]),
    () => inventory([], "win32"),
    () => inventory([], "Linux"),
    () => inventory(Array.from({ length: 65 }, () => ["/bin/zsh", "/bin/zsh"] as const)),
    () => "x".repeat(REMOTE_SHELL_OUTPUT_BYTES + 1),
  ])("rejects malformed, noisy, oversized and ambiguous frames %#", (raw) => {
    expect(() => decode(raw())).toThrow();
  });

  it("enforces WSL platform and remote-only host scope", () => {
    const wsl = { kind: "wsl", hostId: "wsl", distribution: "Linux", username: "alice" } as const;
    expect(() => decodeRemoteShellInventory(inventory([], "darwin"), wsl)).toThrow();
    expect(() =>
      decodeRemoteShellInventory(inventory(), { kind: "local", hostId: "local" }),
    ).toThrow();
    expect(() =>
      decodeRemoteShellInventory(inventory(), { kind: "agent", hostId: "agent" }),
    ).toThrow();
    expect(decode(inventory([], "darwin"))).toEqual([]);
  });
});
