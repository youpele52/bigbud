import { describe, expect, it } from "vitest";
import { runProcess } from "../utils/processRunner.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { makeRemoteAgentInstallOperations } from "./remoteAgentInstall.operation.ts";
import { fixture } from "./remoteAgentAdmission.fixtures.ts";

describe("shared operation production uncertainty boundaries", () => {
  it("preserves transport evidence from real process control failures and failed reconciliation", async () => {
    let calls = 0;
    const control = await openRemoteAgentControl("ssh:fixture", async (input) => {
      if (++calls === 1) return { stdout: "/tmp/fixture/.bigbud/agent" };
      return runProcess(
        process.execPath,
        ["-e", 'process.stderr.write("Broken pipe"); process.exitCode = 255;'],
        input,
      );
    });
    const operations = makeRemoteAgentInstallOperations({
      stage: async () => {
        try {
          await control.run("mutate");
        } catch {
          await control.run("reconcile");
        }
        return { version: "1" };
      },
      activate: async () => ({ currentVersion: "1" }),
      retire: async () => ({ deferred: 0 }),
    });
    const started = operations.start({ executionTargetId: "ssh:fixture", replace: false });
    expect(await operations.wait(started.operationId, 5000)).toMatchObject({
      outcome: "uncertain",
    });
    expect(calls).toBe(3);
  });

  it("reports a committed admission with failed local publication as uncertain using its original ID", async () => {
    const f = fixture("binding");
    const operations = makeRemoteAgentInstallOperations({
      stage: async () => ({ version: "0.2.207" }),
      activate: async (target, id) => {
        await f.admission.fresh(target, id);
        return { currentVersion: "0.2.207" };
      },
      retire: async () => ({ deferred: 0 }),
    });
    const started = operations.start({ executionTargetId: "publication-failure", replace: false });
    expect(await operations.wait(started.operationId, 5000)).toMatchObject({
      outcome: "uncertain",
    });
    expect((await f.control.registry.read()).currentConnectionId).toBe(started.operationId);
    expect(operations.get(started.operationId)?.message).toContain("Check agent status");
  });
});
