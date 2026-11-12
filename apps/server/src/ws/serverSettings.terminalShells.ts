import type { ServerSettings, ServerSettingsPatch } from "@bigbud/contracts";
import {
  DEFAULT_TERMINAL_SHELL_SETTINGS,
  TerminalShellSettings,
} from "@bigbud/contracts/core/settings.terminalShell.ts";
import { ShellHostId, ShellSelection } from "@bigbud/contracts/workspace/terminalShell.ts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Records and discriminated selections replace, never recursively merge. */
export function normalizeTerminalShellSettingsPatch(
  current: TerminalShellSettings,
  patch: ServerSettingsPatch["terminalShells"],
): TerminalShellSettings {
  if (!patch) return current;
  const hostDefaults = patch.localDefault
    ? { ...(patch.hostDefaults ?? current.hostDefaults), local: patch.localDefault }
    : (patch.hostDefaults ?? current.hostDefaults);
  return {
    ...current,
    ...(patch.hostDefaults === undefined && patch.localDefault === undefined
      ? {}
      : { version: 1, origin: "explicit" }),
    hostDefaults,
    suggestionPolicy: patch.suggestionPolicy ?? current.suggestionPolicy,
  } as TerminalShellSettings;
}

/** Preserve recognizable choices even if another field in this atomic object was damaged. */
export function recoverTerminalShellSettings(value: unknown): TerminalShellSettings {
  if (Schema.is(TerminalShellSettings)(value)) return value;
  if (value === null || typeof value !== "object") return DEFAULT_TERMINAL_SHELL_SETTINGS;
  const input = value as Record<string, unknown>;
  const hostDefaults: Record<string, ShellSelection> = {};
  if (input.hostDefaults !== null && typeof input.hostDefaults === "object") {
    for (const [hostId, selection] of Object.entries(input.hostDefaults)) {
      if (Object.keys(hostDefaults).length >= 128) break;
      if (Schema.is(ShellHostId)(hostId) && Schema.is(ShellSelection)(selection)) {
        hostDefaults[hostId] = selection;
      }
    }
  }
  return {
    ...(Object.keys(hostDefaults).length > 0
      ? { version: 1 as const, origin: "explicit" as const }
      : { version: 0 as const, origin: "uninitialized" as const }),
    hostDefaults,
    suggestionPolicy: input.suggestionPolicy === "qualified-history" ? "qualified-history" : "off",
  };
}

export function initializeTerminalShellSettings(
  current: TerminalShellSettings,
  selection: ShellSelection,
  origin: "fresh" | "existing-or-uncertain",
): TerminalShellSettings {
  if (current.version !== 0) return current;
  return {
    ...current,
    version: 1,
    origin: Object.keys(current.hostDefaults).length > 0 ? "explicit" : origin,
    hostDefaults: { local: selection, ...current.hostDefaults },
  };
}

export type TerminalShellInitialization = (
  selection: ShellSelection,
  origin: "fresh" | "existing-or-uncertain",
) => Effect.Effect<ServerSettings, import("@bigbud/contracts").ServerSettingsError>;
