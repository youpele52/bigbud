import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { getRemoteAgentManualInstallEffect } from "../ws/wsExecutionTargetVerification.ts";
import { artifact, source } from "./remoteAgentInstallManager.fixtures.ts";
import {
  buildRemoteAgentManualInstall,
  remoteAgentManualInstallVersion,
} from "./remoteAgentManualInstall.ts";
import { makeRemoteAgentInstaller } from "./remoteAgentServerLayer.installer.ts";

describe("manual remote agent install command", () => {
  it("pins the signed release version and the inbox contract", () => {
    const manual = buildRemoteAgentManualInstall({
      executionTargetId: "ssh:fixture",
      version: remoteAgentManualInstallVersion(source),
    });
    expect(manual).toEqual({
      executionTargetId: "ssh:fixture",
      version: artifact.version,
      command: `curl -fsSL https://bigbud.app/remote-agent.sh | BIGBUD_AGENT_VERSION=${artifact.version} sh`,
      scriptUrl: "https://bigbud.app/remote-agent.sh",
      releaseScriptUrl: `https://github.com/youpele52/bigbud/releases/download/v${artifact.version}/remote-agent.sh`,
      inboxRelativePath: "~/.bigbud/agent/inbox",
    });
  });

  it("names a non-default release repository and rejects unsafe identities", () => {
    expect(
      buildRemoteAgentManualInstall({
        executionTargetId: "ssh:fixture",
        version: "1.2.3",
        repository: "fork/bigbud",
      }).command,
    ).toContain("| BIGBUD_RELEASE_REPOSITORY=fork/bigbud BIGBUD_AGENT_VERSION=1.2.3 sh");
    expect(() =>
      buildRemoteAgentManualInstall({ executionTargetId: "ssh:x", version: "1.2.3; rm -rf ~" }),
    ).toThrow("invalid");
    expect(() =>
      buildRemoteAgentManualInstall({
        executionTargetId: "ssh:x",
        version: "1.2.3",
        repository: "a/b c",
      }),
    ).toThrow("invalid");
    expect(() =>
      remoteAgentManualInstallVersion({
        ...source,
        manifest: {
          schemaVersion: 1,
          artifacts: [
            artifact,
            { ...artifact, version: "9.9.9", targetTriple: "x86_64-unknown-linux-gnu" },
          ],
        },
      }),
    ).toThrow("single release version");
  });

  it("is served through the installer without SSH and refuses Direct SSH targets", async () => {
    const installer = makeRemoteAgentInstaller({
      installManager: { install: async () => ({ artifact }) },
      loadInstallSource: async () => source,
      pool: { close: () => undefined },
    });
    const target = "ssh:host=agent-host&transport=agent";
    const result = await Effect.runPromise(
      getRemoteAgentManualInstallEffect({ executionTargetId: target as never }, installer),
    );
    expect(result).toMatchObject({ version: artifact.version });
    const refused = await Effect.runPromise(
      Effect.flip(
        getRemoteAgentManualInstallEffect(
          { executionTargetId: "ssh:host=direct-host&transport=direct-ssh" as never },
          installer,
        ),
      ),
    );
    expect(refused.message).toContain("unavailable");
  });
});
