import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildBackendChildEnvironment } from "./backendEnv";
import { resolveDesktopSshOwnerBinary } from "./backendEnv.sshOwner";
import { resolvePackagedSshOwnerPlan } from "../env/pathResolver.platform";

const packagedOwner =
  "/Applications/bigbud.app/Contents/Resources/server/ssh-owner/bin/bigbud-ssh-owner";

beforeEach(() => {
  vi.stubEnv("BIGBUD_SSH_OWNER_BIN", "/repo/target/debug/bigbud-ssh-owner");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function backendEnv(isPackaged: boolean, packagedSshOwnerBinary: string | null = null) {
  return buildBackendChildEnvironment({
    packagedOpencodeBinDir: null,
    packagedBundledSkillsDir: null,
    packagedBundledAgentsDir: null,
    packagedWorkspaceAgentBinary: null,
    packagedSshOwnerBinary,
    packagedDesktopSupervisorBinary: null,
    computerUseRuntimeEnv: {},
    backendNodeExecutable: process.execPath,
    isPackaged,
    backendMaxOldSpaceMb: null,
  });
}

it("passes the dev runner's Cargo-built owner to a development backend", () => {
  expect(backendEnv(false).BIGBUD_SSH_OWNER_BIN).toBe("/repo/target/debug/bigbud-ssh-owner");
});

it("drops a relative or unnormalised development owner path", () => {
  vi.stubEnv("BIGBUD_SSH_OWNER_BIN", "relative/owner");
  expect(backendEnv(false)).not.toHaveProperty("BIGBUD_SSH_OWNER_BIN");
  vi.stubEnv("BIGBUD_SSH_OWNER_BIN", "/repo/../owner");
  expect(backendEnv(false)).not.toHaveProperty("BIGBUD_SSH_OWNER_BIN");
});

it("always exports the staged owner for a packaged backend and ignores the environment", () => {
  expect(backendEnv(true, packagedOwner).BIGBUD_SSH_OWNER_BIN).toBe(packagedOwner);
  expect(backendEnv(true)).not.toHaveProperty("BIGBUD_SSH_OWNER_BIN");
});

it("locates the packaged owner beside the bundled server", () => {
  const plan = resolvePackagedSshOwnerPlan("darwin", "/Applications/bigbud.app/Contents/Resources");
  expect(plan.binaryPath).toBe(packagedOwner);
  expect(resolvePackagedSshOwnerPlan("win32", "C:/bigbud/resources").binaryPath).toBe(
    "C:/bigbud/resources/server/ssh-owner/bin/bigbud-ssh-owner.exe",
  );
  expect(
    resolveDesktopSshOwnerBinary({
      isPackaged: true,
      packagedBinary: plan.binaryPath,
      environment: { BIGBUD_SSH_OWNER_BIN: "/elsewhere/owner" },
    }),
  ).toBe(plan.binaryPath);
});
