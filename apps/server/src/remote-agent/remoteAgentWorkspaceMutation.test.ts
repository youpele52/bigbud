import { Effect, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WsProjectsWriteFileRpc } from "@bigbud/contracts/server/rpc.workspace.ts";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { makeRemoteWorkspaceRuntime } from "../workspace-runtime/Layers/WorkspaceRuntime.remote.ts";
import { projectWriteFileError } from "../ws/wsRpcHandlers.workspace.ts";
import { configureRemoteAgentOwners } from "./remoteAgentOwners.ts";
import { installManagerFixture, installInput } from "./remoteAgentInstallManager.fixtures.ts";
import * as Control from "./remoteAgentControl.ts";
import { RemoteAgentConnectionError, type RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { makeRemoteAgentWorkspaceMutation } from "./remoteAgentWorkspaceMutation.ts";

const input = {
  executionTargetId: "ssh:fixture",
  operationId: "write-original",
  cwd: "/workspace",
  relativePath: "file.txt",
  contents: "edited",
  expectedSha256: "a".repeat(64),
};
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
});

async function fixture() {
  const local = ManagedRuntime.make(NodeSqlite.layer({ filename: ":memory:" }));
  disposals.push(() => local.dispose());
  await local.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
  const store = await local.runPromise(makeRemoteAgentRuntimeBindings);
  configureRemoteAgentOwners(store);
  const installed = installManagerFixture();
  await installed.manager.install(installInput);
  const runtime = (await installed.control.registry.read()).builds[0]!.runtime;
  const binding = { runtime, expectedEpoch: "epoch-1", connectionId: "connection-1" };
  vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue(installed.control);
  const response = {
    terminal: true,
    errorCode: "WRITE_IO",
    errorMessage: "Directory sync failed after replacing the file.",
  };
  const write = vi.fn(async () => response);
  const request = vi.fn(async (frame: RemoteAgentFrame) => {
    if (frame.type === "workspaceOpenRequest")
      return { value: { errorCode: "", errorMessage: "" } };
    return { type: "writeFileResponse", value: await write() };
  });
  const makeRuntime = (selected: RemoteAgentRuntimeBinding = binding) =>
    makeRemoteWorkspaceRuntime({
      resolve: async (target) =>
        new RemoteAgentWorkspaceClient(
          { request } as unknown as RemoteAgentConnection,
          undefined,
          makeRemoteAgentWorkspaceMutation(target, selected),
        ),
    });
  const failedWrite = async (value = input, selected = binding) => {
    const error = await Effect.runPromise(
      Effect.flip(makeRuntime(selected).files.writeFile(value)),
    );
    return Schema.encodeSync(WsProjectsWriteFileRpc.errorSchema)(projectWriteFileError(error));
  };
  return { store, installed, binding, write, response, makeRuntime, failedWrite };
}

describe("durable workspace write disposition", () => {
  it("encodes native terminal errors and never replays an existing owner on a new runtime", async () => {
    const test = await fixture();
    expect(await test.failedWrite()).toMatchObject({ writeDisposition: "terminal" });
    const saved = await test.store.get("workspace-write:write-original");
    expect(saved?.state).toBe("terminal");
    const statePath = `${test.installed.control.root}/runtimes/g2`;
    const replacement = {
      ...test.binding,
      runtime: {
        ...test.binding.runtime,
        generation: "g2",
        statePath,
        socketPath: `${statePath}/supervisor.sock`,
        logPath: `${statePath}/supervisor.log`,
      },
      expectedEpoch: "epoch-2",
    };
    expect(await test.failedWrite(input, replacement)).toMatchObject({
      writeDisposition: "terminal",
    });
    for (const changed of [
      { ...input, contents: "another draft" },
      { ...input, executionTargetId: "ssh:another-target" },
    ]) {
      expect(await test.failedWrite(changed, replacement)).toMatchObject({
        writeDisposition: "unknown",
      });
    }
    expect(await test.store.get("workspace-write:write-original")).toEqual(saved);
    expect(test.write).toHaveBeenCalledOnce();
  });

  it("keeps lost-transport writes unknown and fenced even after draft edits or runtime replacement", async () => {
    const test = await fixture();
    test.write.mockRejectedValue(new RemoteAgentConnectionError("response lost"));
    expect(await test.failedWrite()).toMatchObject({ writeDisposition: "unknown" });
    const replacement = { ...test.binding, expectedEpoch: "epoch-2" };
    expect(await test.failedWrite(input, replacement)).toMatchObject({
      writeDisposition: "unknown",
    });
    expect(await test.failedWrite({ ...input, contents: "new draft" }, replacement)).toMatchObject({
      writeDisposition: "unknown",
    });
    expect((await test.store.get("workspace-write:write-original"))?.state).toBe("outcome-unknown");
    expect((await test.installed.control.registry.read()).pins).toHaveLength(1);
    expect(test.write).toHaveBeenCalledOnce();
  });

  it("reports a new reservation's pin failure as positively not dispatched", async () => {
    const test = await fixture();
    vi.spyOn(test.installed.control.registry, "update").mockRejectedValueOnce(
      new Error("pin failed"),
    );
    expect(await test.failedWrite()).toMatchObject({ writeDisposition: "not-dispatched" });
    expect(test.write).not.toHaveBeenCalled();
    expect(await test.store.get("workspace-write:write-original")).toBeUndefined();
  });

  it("does not treat caller interruption as terminal while the native write is pending", async () => {
    const test = await fixture();
    const pending = Promise.withResolvers<typeof test.response>();
    test.write.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const outcome = Effect.runPromise(test.makeRuntime().files.writeFile(input), {
      signal: controller.signal,
    }).catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(test.write).toHaveBeenCalledOnce());
    controller.abort();
    const failure = await outcome;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty("writeDisposition", "terminal");
    expect((await test.store.get("workspace-write:write-original"))?.state).toBe(
      "may-have-been-sent",
    );
    pending.resolve(test.response);
    await vi.waitFor(async () => {
      expect((await test.store.get("workspace-write:write-original"))?.state).toBe("terminal");
    });
  });

  it.each(["owner", "pin"])(
    "preserves terminal success evidence when %s cleanup fails",
    async (boundary) => {
      const test = await fixture();
      test.response.errorCode = "";
      test.response.errorMessage = "";
      if (boundary === "owner") {
        const update = test.store.update;
        vi.spyOn(test.store, "update").mockImplementation(async (key, transition) => {
          const current = await test.store.get(key);
          if (current && transition(current).state === "terminal")
            throw new Error("owner cleanup failed");
          return update(key, transition);
        });
      } else {
        const update = test.installed.control.registry.update;
        let calls = 0;
        vi.spyOn(test.installed.control.registry, "update").mockImplementation(
          async (transition) => {
            if (++calls === 2) throw new Error("pin cleanup failed");
            return update(transition);
          },
        );
      }
      expect(await test.failedWrite()).toMatchObject({ writeDisposition: "terminal" });
      expect(test.write).toHaveBeenCalledOnce();
      expect((await test.store.get("workspace-write:write-original"))?.state).toBe(
        boundary === "owner" ? "may-have-been-sent" : "terminal",
      );
    },
  );

  it("does not dispatch malformed conditional writes", async () => {
    const test = await fixture();
    expect(await test.failedWrite({ ...input, expectedSha256: "invalid" })).toMatchObject({
      writeDisposition: "not-dispatched",
    });
    expect(test.write).not.toHaveBeenCalled();
  });
});
