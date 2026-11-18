import { describe, expect, it, vi } from "vitest";
import { makeRemoteAgentInstallOperations } from "./remoteAgentInstall.operation.ts";
import { installInput, installManagerFixture } from "./remoteAgentInstallManager.fixtures.ts";
import {
  prepareStagedRemoteAgentCandidate,
  RemoteAgentUpdateUncertainError,
} from "./remoteAgentUpdate.prepare.ts";

describe("shared install outcome after candidate launch acknowledgement loss", () => {
  it("keeps the real preparation wrapper uncertain and does not launch again or retire", async () => {
    const fixture = installManagerFixture();
    const transport = new Error("SSH exited 255 after remote launch");
    let launches = 0;
    let preparationError: unknown;
    fixture.control.run = async (command) => {
      if (command.includes("launch-reserved")) {
        launches += 1;
        throw transport;
      }
      return "";
    };
    const retire = vi.fn(async () => ({ deferred: 0 }));
    const operations = makeRemoteAgentInstallOperations({
      stage: async () => {
        await fixture.manager.install(installInput);
        return { version: "0.2.207" };
      },
      activate: async (target, requestId) => {
        const state = await fixture.control.registry.read();
        try {
          await prepareStagedRemoteAgentCandidate({
            target,
            requestId,
            buildId: state.pending!,
            control: fixture.control,
          });
        } catch (cause) {
          preparationError = cause;
          throw new Error("Activation preparation lost its result", { cause });
        }
        return { currentVersion: "0.2.207" };
      },
      retire,
    });
    const started = operations.start({
      executionTargetId: installInput.executionTargetId,
      replace: true,
    });
    expect(await operations.wait(started.operationId, 5000)).toMatchObject({
      outcome: "uncertain",
    });
    expect(preparationError).toBeInstanceOf(RemoteAgentUpdateUncertainError);
    expect((preparationError as Error).cause).toBe(transport);
    expect((await fixture.control.registry.read()).launches[0]?.phase).toBe("spawn-uncertain");
    expect(launches).toBe(1);
    expect(retire).not.toHaveBeenCalled();
  });
});
