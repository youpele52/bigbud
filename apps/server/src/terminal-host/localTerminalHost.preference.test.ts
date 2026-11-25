import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { localTerminalHostSelection } from "./localTerminalHost.layer.ts";
import {
  resolveLocalTerminalHostMode,
  terminalHostControlledByEnvironment,
} from "./localTerminalHost.paths.ts";
import {
  latchTerminalHostPreference,
  latchedTerminalHostPreference,
  readTerminalHostPreference,
  resetTerminalHostPreferenceForTest,
} from "./localTerminalHost.preference.ts";

const dirs: string[] = [];
const stateDirWith = (settings: string | undefined) => {
  const dir = mkdtempSync(join(tmpdir(), "bbth-pref-"));
  dirs.push(dir);
  if (settings !== undefined) writeFileSync(join(dir, "settings.json"), settings);
  return dir;
};

afterEach(() => {
  resetTerminalHostPreferenceForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("terminal host Settings preference", () => {
  it("reads only an explicit true and treats missing or broken settings as off", () => {
    expect(readTerminalHostPreference("/s", () => '{"terminalHostEnabled":true}')).toBe(true);
    expect(readTerminalHostPreference("/s", () => '{"terminalHostEnabled":"true"}')).toBe(false);
    expect(readTerminalHostPreference("/s", () => "{}")).toBe(false);
    expect(readTerminalHostPreference("/s", () => "not json")).toBe(false);
    expect(
      readTerminalHostPreference("/s", () => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });

  it("latches the first read so a later change applies only after a restart", () => {
    const on = stateDirWith('{"terminalHostEnabled":true}');
    expect(latchedTerminalHostPreference()).toBe(false);
    expect(latchTerminalHostPreference(on)).toBe(true);
    writeFileSync(join(on, "settings.json"), '{"terminalHostEnabled":false}');
    expect(latchTerminalHostPreference(on)).toBe(true);
    expect(latchedTerminalHostPreference()).toBe(true);
  });

  it("opts in before qualification, while an explicit environment value always wins", () => {
    expect(resolveLocalTerminalHostMode({}, false, true)).toBe("enabled");
    expect(resolveLocalTerminalHostMode({}, false, false)).toBe("adopt-only");
    expect(resolveLocalTerminalHostMode({ BIGBUD_TERMINAL_HOST: "0" }, false, true)).toBe(
      "adopt-only",
    );
    expect(resolveLocalTerminalHostMode({ BIGBUD_TERMINAL_HOST: "1" }, false, false)).toBe(
      "enabled",
    );
    expect(terminalHostControlledByEnvironment({})).toBe(false);
    expect(terminalHostControlledByEnvironment({ BIGBUD_TERMINAL_HOST: "1" })).toBe(true);
    expect(terminalHostControlledByEnvironment({ BIGBUD_TERMINAL_HOST: "0" })).toBe(true);
  });

  it("selects the host from saved settings at startup, but never on Windows", () => {
    const on = stateDirWith('{"terminalHostEnabled":true}');
    expect(localTerminalHostSelection({ stateDir: on, environment: {}, platform: "darwin" })).toBe(
      "enabled",
    );
    expect(
      localTerminalHostSelection({ stateDir: on, environment: {}, platform: "win32" }),
    ).toBeUndefined();
  });

  it("leaves a user with no saved preference exactly as before", () => {
    const off = stateDirWith(undefined);
    expect(
      localTerminalHostSelection({
        stateDir: off,
        environment: {},
        platform: "darwin",
        rootExists: () => false,
      }),
    ).toBeUndefined();
  });
});
