import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";
import {
  DEFAULT_TERMINAL_SHELL_SETTINGS,
  TerminalShellSettings,
  TerminalShellSettingsPatch,
} from "./settings.terminalShell";

const initialized = {
  version: 1,
  origin: "existing-or-uncertain",
  hostDefaults: { local: { kind: "legacy-auto" } },
  suggestionPolicy: "off",
} as const;

describe("terminal shell settings versioning", () => {
  it("keeps old settings uninitialized with suggestions off", () => {
    expect(Schema.decodeUnknownSync(ServerSettings)({}).terminalShells).toEqual(
      DEFAULT_TERMINAL_SHELL_SETTINGS,
    );
    expect(DEFAULT_SERVER_SETTINGS.terminalShells).toEqual(DEFAULT_TERMINAL_SHELL_SETTINGS);
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({
        terminalShells: { hostDefaults: { local: { kind: "legacy-auto" } } },
      }),
    ).toEqual({ terminalShells: { hostDefaults: { local: { kind: "legacy-auto" } } } });
  });

  it("decodes the explicit version-zero representation without claiming freshness", () => {
    expect(
      Schema.decodeUnknownSync(TerminalShellSettings)(DEFAULT_TERMINAL_SHELL_SETTINGS),
    ).toEqual({
      version: 0,
      origin: "uninitialized",
      hostDefaults: {},
      suggestionPolicy: "off",
    });
    expect(Schema.is(TerminalShellSettings)({})).toBe(false);
  });

  it("round trips durable origin and host-scoped concrete selections", () => {
    const settings = {
      ...initialized,
      origin: "fresh",
      hostDefaults: {
        local: { kind: "profile", profileId: "local:pwsh:stable" },
        "ssh:target:account": { kind: "legacy-auto" },
      },
    };
    expect(
      Schema.decodeUnknownSync(TerminalShellSettings)(
        Schema.encodeSync(TerminalShellSettings)(
          Schema.decodeUnknownSync(TerminalShellSettings)(settings),
        ),
      ),
    ).toEqual(settings);
  });

  it("rejects inconsistent or future migration versions rather than treating them as fresh", () => {
    expect(Schema.is(TerminalShellSettings)({ ...initialized, version: 2 })).toBe(false);
    expect(Schema.is(TerminalShellSettings)({ ...initialized, version: 0 })).toBe(false);
    expect(Schema.is(TerminalShellSettings)({ ...initialized, origin: "uninitialized" })).toBe(
      false,
    );
    expect(Schema.is(TerminalShellSettings)({ ...initialized, suggestionPolicy: "on" })).toBe(
      false,
    );
  });

  it("only patches preferences, never migration evidence", () => {
    expect(
      Schema.decodeUnknownSync(TerminalShellSettingsPatch)({
        version: 0,
        origin: "fresh",
        suggestionPolicy: "qualified-history",
      }),
    ).toEqual({ suggestionPolicy: "qualified-history" });
    expect(Schema.decodeUnknownSync(TerminalShellSettingsPatch)({})).toEqual({});
  });

  it("bounds host defaults and rejects command-shaped identifiers", () => {
    const hostDefaults = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`host:${index}`, { kind: "legacy-auto" }]),
    );
    expect(Schema.is(TerminalShellSettings)({ ...initialized, hostDefaults })).toBe(false);
    expect(
      Schema.is(TerminalShellSettings)({
        ...initialized,
        hostDefaults: { "user@host": { kind: "legacy-auto" } },
      }),
    ).toBe(false);
  });
});
