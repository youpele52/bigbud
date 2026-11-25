import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "electron";
import { buildBackendChildEnvironment } from "./backendEnv";
import { resolveDesktopMainConfig } from "../main.config";

const profile = "/tmp/bigbud-ssh-owner-dev-9KZCS5";
const settings = {
  BIGBUD_SSH_OWNER: "1",
  BIGBUD_SSH_OWNER_BIN: "/test/owner",
  BIGBUD_SSH_OWNER_NORMAL_DEV_READY: "1",
  BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE: profile,
};
const originalPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
  vi.stubEnv("BIGBUD_HOME", profile);
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.unstubAllEnvs();
});

function backendEnv(isPackaged: boolean) {
  return buildBackendChildEnvironment({
    packagedOpencodeBinDir: null,
    packagedBundledSkillsDir: null,
    packagedBundledAgentsDir: null,
    packagedWorkspaceAgentBinary: null,
    packagedDesktopSupervisorBinary: null,
    computerUseRuntimeEnv: {},
    backendNodeExecutable: process.execPath,
    isPackaged,
    backendMaxOldSpaceMb: null,
  });
}

function mainConfig(isPackaged: boolean) {
  return resolveDesktopMainConfig({ isPackaged, getVersion: () => "0.0.0" } as App, "/desktop");
}

it("passes the guarded opt-in and puts backend and Electron state under the same isolated base", () => {
  const env = backendEnv(false);
  expect(env).toMatchObject({ ...settings, BIGBUD_HOME: profile, BIGBUD_DESKTOP_PACKAGED: "0" });
  expect(mainConfig(false)).toMatchObject({
    isolatedUserDataPath: `${profile}/electron`,
    serverSettingsPath: `${profile}/dev/settings.json`,
  });
});

it("strips every opt-in variable from packaged backend startup even with a dev URL", () => {
  const env = backendEnv(true);
  expect(env.BIGBUD_DESKTOP_PACKAGED).toBe("1");
  for (const name of Object.keys(settings)) expect(env).not.toHaveProperty(name);
  expect(mainConfig(true).isolatedUserDataPath).toBeUndefined();
});

it("does not silently launch legacy SSH when the Windows dev profile is invalid", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(() => backendEnv(false)).toThrow("No legacy backend was started");
});

it.each([
  ["VITE_DEV_SERVER_URL", undefined],
  ["BIGBUD_SSH_OWNER_NORMAL_DEV_READY", "0"],
  ["BIGBUD_SSH_OWNER_BIN", "relative/owner"],
  ["BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", "/normal/home"],
  ["BIGBUD_HOME", "/normal/home"],
])("strips opt-in when %s is not valid (%s)", (name, value) => {
  vi.stubEnv(name, value);
  const env = backendEnv(false);
  for (const key of Object.keys(settings)) expect(env).not.toHaveProperty(key);
  expect(mainConfig(false).isolatedUserDataPath).toBeUndefined();
});
