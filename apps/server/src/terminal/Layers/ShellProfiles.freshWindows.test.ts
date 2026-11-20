import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vitest";
import { ServerConfig } from "../../startup/config";
import { runTerminalShellSettingsMigration } from "../../startup/serverRuntimeStartup.terminalShells";
import { ServerSettingsLive, ServerSettingsService } from "../../ws/serverSettings";
import { LocalShellDiscoveryError } from "../Services/LocalShellProfiles";
import { LOCAL_SHELL_HOST, shellProfileId } from "./ShellProfiles.identity";
import {
  discoverFreshWindowsShellSelection,
  productionFreshWindowsShellSelection,
  selectFreshWindowsShellProfile,
} from "./ShellProfiles.freshWindows";

function profile(kind: TerminalShellProfile["kind"], executable: string): TerminalShellProfile {
  return {
    profileId: shellProfileId(LOCAL_SHELL_HOST, executable, [], "win32"),
    host: LOCAL_SHELL_HOST,
    kind,
    executable,
    args: [],
    displayName: kind,
    platform: "win32",
    availability: "available",
    integration: { status: "unavailable", reason: "not-qualified" },
  };
}
const pwsh = profile("pwsh", "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
const powershell = profile("windows-powershell", "C:\\Windows\\System32\\powershell.exe");
const cmd = profile("cmd", "C:\\Windows\\System32\\cmd.exe");
const selection = (value: TerminalShellProfile) => ({
  kind: "profile",
  profileId: value.profileId,
});

it("ranks available local Windows shells without mutating inventory or using suggestion status", () => {
  const inventory = Object.freeze([cmd, powershell, pwsh]);
  expect(selectFreshWindowsShellProfile(inventory)).toEqual(selection(pwsh));
  expect(selectFreshWindowsShellProfile([powershell, cmd])).toEqual(selection(powershell));
  expect(selectFreshWindowsShellProfile([cmd])).toEqual(selection(cmd));
  expect(inventory).toEqual([cmd, powershell, pwsh]);
  for (const invalid of [
    { ...pwsh, availability: "unavailable" as const },
    { ...pwsh, platform: "linux" as const },
    { ...pwsh, host: { kind: "ssh" as const, hostId: "remote" } },
    { ...pwsh, host: { kind: "local" as const, hostId: "other-host" } },
    profile("other", "C:\\other.exe"),
  ]) {
    expect(selectFreshWindowsShellProfile([invalid, cmd])).toEqual(selection(cmd));
    expect(selectFreshWindowsShellProfile([invalid])).toBeUndefined();
  }
});

it("breaks equal-kind ties deterministically, independent of discovery order", () => {
  const other = profile("pwsh", "C:\\Other\\pwsh.exe");
  expect(selectFreshWindowsShellProfile([pwsh, other])).toEqual(selection(other));
  expect(selectFreshWindowsShellProfile([other, pwsh])).toEqual(selection(other));
});

it.effect("the closed production gate never evaluates inventory", () =>
  Effect.gen(function* () {
    expect(yield* discoverFreshWindowsShellSelection(Effect.die("must not probe"))).toBeUndefined();
    // Filesystem support being available must not open the production rollout gate.
    expect(yield* productionFreshWindowsShellSelection).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discovery errors remain errors rather than an empty or fallback inventory", () =>
  Effect.gen(function* () {
    const result = yield* discoverFreshWindowsShellSelection(
      Effect.fail(new LocalShellDiscoveryError({ reason: "timed-out" })),
      true,
    ).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
  }),
);

const settingsLayer = ServerSettingsLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-fresh-shell-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "qualified ranking feeds atomic migration once; later installations cannot change it",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.start;
      yield* runTerminalShellSettingsMigration({
        platform: "win32",
        evidence: "fresh",
        discoverFreshWindowsSelection: discoverFreshWindowsShellSelection(
          Effect.succeed([cmd, powershell]),
          true,
        ),
      });
      yield* runTerminalShellSettingsMigration({
        platform: "win32",
        evidence: "fresh",
        discoverFreshWindowsSelection: Effect.die("already persisted; must not rerank"),
      });
      expect((yield* settings.getSettings).terminalShells).toMatchObject({
        version: 1,
        origin: "fresh",
        hostDefaults: { local: selection(powershell) },
        suggestionPolicy: "off",
      });
    }).pipe(Effect.provide(settingsLayer), Effect.scoped),
);
