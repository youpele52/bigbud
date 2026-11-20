import { describe, expect, it } from "vitest";
import {
  LOCAL_SERVICE_BACKEND_STOP_POST as stopPost,
  localSupervisorServiceUnitReference,
} from "./localSupervisorService.references.unit.ts";
import { quoteServiceFixturePath as quote } from "./localSupervisorService.references.fixture.ts";

const authority = "a".repeat(32);
const name = `bigbud-rust-${authority}.service`;
const home = '/home/account space%$"';
const binary = `${home}/.bigbud/agent/bin/1.0.0/${"1".repeat(64)}/bigbud-remote-agent`;
const config = `${home}/.bigbud/backend-services/${authority}/config-v1`;
const text = `# bigbud account-service v1; independent Rust terminal owner\n[Service]\nExecStart=${quote(binary)} --backend-service run ${quote(config)} rust\n`;

describe("private generated service unit references", () => {
  it("decodes literal quoted paths without interpreting specifiers or environment variables", () => {
    expect(localSupervisorServiceUnitReference(text, name, home)).toEqual({
      authority,
      binaryPath: binary,
      configPath: config,
    });
  });
  it.each([
    text.replace("%%", "%i"),
    text.replace("run ", "run --unexpected "),
    text.replace(" rust\n", " backend\n"),
    text + "ExecStartPre=/unknown\n",
    text.replace("account-service v1", "account-service v2"),
    // The clean-stop counter flush belongs to the backend unit only.
    text + `${stopPost}\n`,
  ])("preserves unknown unit metadata instead of treating it as unreferenced", (changed) => {
    expect(() => localSupervisorServiceUnitReference(changed, name, home)).toThrow();
  });
  it("accepts only the exact generated backend stop-post command", () => {
    const backendName = `bigbud-backend-${authority}.service`;
    const backend = `# bigbud account-service v1; user scope only\n[Service]\nExecStart=${quote(binary)} --backend-service run ${quote(config)} backend\n${stopPost}\n`;
    expect(localSupervisorServiceUnitReference(backend, backendName, home)).toEqual({
      authority,
      binaryPath: binary,
      configPath: config,
    });
    for (const changed of [
      backend + `${stopPost}\n`,
      backend.replace("reset-failed", "start"),
      backend.replace(stopPost, `${stopPost} extra`),
    ])
      expect(() => localSupervisorServiceUnitReference(changed, backendName, home)).toThrow();
  });
});
