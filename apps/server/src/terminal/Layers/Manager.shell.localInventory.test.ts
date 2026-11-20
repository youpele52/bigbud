import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { makeListTerminalShellProfiles } from "./Manager.shell.inventory";
import { LOCAL_SHELL_HOST } from "./ShellProfiles.identity";

describe("settings local inventory", () => {
  function fixture(platform: NodeJS.Platform = "darwin") {
    const listLocalShellProfiles = vi.fn(() =>
      Effect.succeed({ host: LOCAL_SHELL_HOST, profiles: [] }),
    );
    const requireSession = vi.fn(() => Effect.die("must not access a pane"));
    const list = makeListTerminalShellProfiles(
      {
        listLocalShellProfiles,
        requireSession,
        withThreadLock: () => Effect.die("must not lock an arbitrary thread"),
      },
      platform,
    );
    return { list, listLocalShellProfiles };
  }
  it("discovers local profiles without opening or depending on a pane", async () => {
    const { list, listLocalShellProfiles } = fixture();
    expect(await Effect.runPromise(list({ scope: "local-settings" }))).toEqual({
      host: LOCAL_SHELL_HOST,
      profiles: [],
      localDefaultsEnabled: true,
    });
    expect(listLocalShellProfiles).toHaveBeenCalledOnce();
  });
  it("Windows gate does not probe and cannot be enabled by saved preferences", async () => {
    const { list, listLocalShellProfiles } = fixture("win32");
    expect(await Effect.runPromise(list({ scope: "local-settings" }))).toEqual({
      host: LOCAL_SHELL_HOST,
      profiles: [],
      localDefaultsEnabled: false,
    });
    expect(listLocalShellProfiles).not.toHaveBeenCalled();
  });
});
