import type { ShellSelection } from "@bigbud/contracts/workspace/terminalShell.ts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { LocalShellDiscoveryError } from "../terminal/Services/LocalShellProfiles";
import type { TerminalShellInstallEvidence } from "./config.terminalShells.ts";
import { ServerConfig } from "./config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { productionFreshWindowsShellSelection } from "../terminal/Layers/ShellProfiles.freshWindows";

export interface TerminalShellMigrationOptions<E = never> {
  readonly platform?: NodeJS.Platform;
  readonly evidence?: TerminalShellInstallEvidence;
  /** Phase 2 supplies host-local, executable inventory with pwsh > Windows PS > cmd ordering. */
  readonly discoverFreshWindowsSelection?: Effect.Effect<ShellSelection | undefined, E>;
}

export const runTerminalShellSettingsMigration = Effect.fn("runTerminalShellSettingsMigration")(
  function* <E>(options?: TerminalShellMigrationOptions<E>) {
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const current = yield* settings.getSettings;
    if (current.terminalShells.version !== 0 || !settings.initializeTerminalShells) return;
    const evidence =
      options?.evidence ?? config.terminalShellInstallEvidence ?? "existing-or-uncertain";
    let selection: ShellSelection = { kind: "legacy-auto" };
    if ((options?.platform ?? process.platform) === "win32" && evidence === "fresh") {
      const discovery: Effect.Effect<
        ShellSelection | undefined,
        E | LocalShellDiscoveryError,
        FileSystem.FileSystem
      > = options?.discoverFreshWindowsSelection ?? productionFreshWindowsShellSelection;
      const discovered = yield* discovery.pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (!discovered || discovered.kind !== "profile") {
        yield* Effect.logWarning(
          "terminal shell inventory unavailable; retaining compatibility behavior",
        );
        return;
      }
      selection = discovered;
    }
    // Initialization reacquires the settings semaphore and rechecks the current version after discovery.
    yield* settings
      .initializeTerminalShells(selection, evidence)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "failed to persist terminal shell migration; retaining compatibility behavior",
            { cause },
          ),
        ),
      );
  },
);
