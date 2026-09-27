import { afterEach, expect, it } from "vitest";
import { buildBackendChildEnvironment } from "./backendEnv";

const oldEndpoint = process.env.BIGBUD_SYSTEM_MONITOR_AGENT_ENDPOINT;
const oldToken = process.env.BIGBUD_SYSTEM_MONITOR_AGENT_TOKEN;
afterEach(() => {
  if (oldEndpoint === undefined) delete process.env.BIGBUD_SYSTEM_MONITOR_AGENT_ENDPOINT;
  else process.env.BIGBUD_SYSTEM_MONITOR_AGENT_ENDPOINT = oldEndpoint;
  if (oldToken === undefined) delete process.env.BIGBUD_SYSTEM_MONITOR_AGENT_TOKEN;
  else process.env.BIGBUD_SYSTEM_MONITOR_AGENT_TOKEN = oldToken;
});

it("does not place monitor agent credentials in the backend child environment", () => {
  process.env.BIGBUD_SYSTEM_MONITOR_AGENT_ENDPOINT = "http://127.0.0.1:1/snapshot";
  process.env.BIGBUD_SYSTEM_MONITOR_AGENT_TOKEN = "secret";
  const env = buildBackendChildEnvironment({
    packagedOpencodeBinDir: null,
    packagedBundledSkillsDir: null,
    packagedBundledAgentsDir: null,
    packagedWorkspaceAgentBinary: null,
    packagedDesktopSupervisorBinary: null,
    computerUseRuntimeEnv: {},
    backendNodeExecutable: process.execPath,
    isPackaged: false,
    backendMaxOldSpaceMb: null,
  });
  expect(env.BIGBUD_SYSTEM_MONITOR_AGENT_ENDPOINT).toBeUndefined();
  expect(env.BIGBUD_SYSTEM_MONITOR_AGENT_TOKEN).toBeUndefined();
});
