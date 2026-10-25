import {
  DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE,
  DEV_APP_FATAL_EXIT_CODE,
  DEV_APP_RESTART_EXIT_CODE,
} from "@bigbud/shared/DevLauncher";
import { describe, expect, it } from "vitest";

import { createAppQuitActions } from "./main.appQuitActions";

function fakeApp() {
  const calls: string[] = [];
  const willQuit: Array<(event: { preventDefault: () => void }) => void> = [];
  const appInstance = {
    exit: (code?: number) => calls.push(`exit:${String(code)}`),
    once: (event: string, listener: (event: { preventDefault: () => void }) => void) => {
      calls.push(`once:${event}`);
      willQuit.push(listener);
    },
    quit: () => calls.push("quit"),
    relaunch: () => calls.push("relaunch"),
  };
  const emitWillQuit = () => {
    for (const listener of willQuit.splice(0))
      listener({ preventDefault: () => calls.push("preventDefault") });
  };
  return { appInstance: appInstance as never, calls, emitWillQuit };
}

describe("createAppQuitActions", () => {
  for (const isDevelopment of [false, true]) {
    it(`quits after teardown (isDevelopment=${isDevelopment})`, () => {
      const fake = fakeApp();
      const actions = createAppQuitActions({
        appInstance: fake.appInstance,
        isDevelopment,
        prepareForAppQuit: (reason) => fake.calls.push(`prepare:${reason}`),
      });
      actions.quit("menu-quit");
      expect(fake.calls).toEqual(["prepare:menu-quit", "quit"]);
    });
  }

  it("keeps app.relaunch() for packaged and unsupervised builds", () => {
    const fake = fakeApp();
    createAppQuitActions({
      appInstance: fake.appInstance,
      isDevelopment: false,
      prepareForAppQuit: (reason) => fake.calls.push(`prepare:${reason}`),
    }).restart("settings-restart");
    expect(fake.calls).toEqual(["relaunch", "prepare:settings-restart", "quit"]);
  });

  it("exits with the restart sentinel under the dev launcher instead of relaunching", () => {
    const fake = fakeApp();
    createAppQuitActions({
      appInstance: fake.appInstance,
      isDevelopment: true,
      prepareForAppQuit: (reason) => fake.calls.push(`prepare:${reason}`),
    }).restart("floating-assistant-menu-restart");
    expect(fake.calls).toEqual([
      "prepare:floating-assistant-menu-restart",
      "once:will-quit",
      "quit",
    ]);
    fake.emitWillQuit();
    expect(fake.calls.slice(3)).toEqual(["preventDefault", `exit:${DEV_APP_RESTART_EXIT_CODE}`]);
    expect(fake.calls).not.toContain("relaunch");
  });

  for (const [action, devExitCode] of [
    ["quitAfterFatalError", DEV_APP_FATAL_EXIT_CODE],
    ["quitDuplicateInstance", DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE],
  ] as const) {
    it(`${action} keeps the packaged exit and reports ${devExitCode} to the dev launcher`, () => {
      const packaged = fakeApp();
      createAppQuitActions({
        appInstance: packaged.appInstance,
        isDevelopment: false,
        prepareForAppQuit: () => undefined,
      })[action]();
      packaged.emitWillQuit();
      expect(packaged.calls).toEqual(["quit"]);

      const dev = fakeApp();
      createAppQuitActions({
        appInstance: dev.appInstance,
        isDevelopment: true,
        prepareForAppQuit: () => undefined,
      })[action]();
      dev.emitWillQuit();
      expect(dev.calls).toEqual([
        "once:will-quit",
        "quit",
        "preventDefault",
        `exit:${devExitCode}`,
      ]);
    });
  }
});
