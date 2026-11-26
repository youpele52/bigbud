import { describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";

import type { RemoteAgentFrame } from "../../remote-agent/remoteAgentProtocol.ts";
import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import {
  WORKSPACE_ENTRY_ALREADY_EXISTS,
  WORKSPACE_ENTRY_NOT_FOUND,
} from "../Services/WorkspaceMutations.ts";
import { makeRemoteWorkspaceMutations } from "./WorkspaceRuntime.remote.mutations.ts";

const target = "ssh:host=example&transport=agent";
const cwd = "/srv/project";

function fakeClient(input: {
  readonly capabilities: ReadonlyArray<string>;
  readonly reply?: (frame: RemoteAgentFrame) => RemoteAgentFrame | Promise<RemoteAgentFrame>;
}) {
  const sent: RemoteAgentFrame[] = [];
  const client = {
    connection: {
      supportsCapability: (name: string) => input.capabilities.includes(name),
      request: async (frame: RemoteAgentFrame) => {
        sent.push(frame);
        if (!input.reply) throw new Error("no reply");
        return input.reply(frame);
      },
    },
  } as unknown as RemoteAgentWorkspaceClient;
  return { client, sent };
}

function make(client: RemoteAgentWorkspaceClient, resolveFails = false) {
  const open = vi.fn(async () => "workspace-handle");
  const mutations = makeRemoteWorkspaceMutations({
    resolve: async () => {
      if (resolveFails) throw new Error("unreachable");
      return client;
    },
    remoteTarget: (value) => value ?? target,
    open,
  });
  return { mutations, open };
}

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const reason = exit.cause.reasons.find((candidate) => candidate._tag === "Fail");
  if (!reason || reason._tag !== "Fail") throw new Error("expected a typed failure");
  return reason.error;
}

const all = ["workspace.write-create-only", "workspace.mkdir", "workspace.delete"];

describe("remote workspace mutations", () => {
  it("allows only what the agent advertises; remote deletes are permanent", async () => {
    const full = make(fakeClient({ capabilities: all }).client).mutations;
    expect(await Effect.runPromise(full.entryActions({ cwd, executionTargetId: target }))).toEqual({
      createFile: { allowed: true },
      createFolder: { allowed: true },
      delete: { allowed: true, permanent: true },
    });
    const old = make(
      fakeClient({ capabilities: ["workspace.write-create-only"] }).client,
    ).mutations;
    const actions = await Effect.runPromise(old.entryActions({ cwd, executionTargetId: target }));
    expect(actions.createFolder).toEqual({ allowed: false, reason: "agentTooOld" });
    expect(actions.delete).toMatchObject({ allowed: false, reason: "agentTooOld" });
    const offline = make(fakeClient({ capabilities: all }).client, true).mutations;
    expect(
      (await Effect.runPromise(offline.entryActions({ cwd, executionTargetId: target }))).delete,
    ).toMatchObject({ allowed: false, reason: "ownerUnavailable" });
  });

  it("never sends a frame to an agent without the capability", async () => {
    const { client, sent } = fakeClient({ capabilities: [] });
    const { mutations, open } = make(client);
    const error = await failure(
      mutations.deleteEntry({
        cwd,
        executionTargetId: target,
        relativePath: "src",
        expectedKind: "directory",
      }),
    );
    expect(error).toMatchObject({ writeDisposition: "not-dispatched" });
    expect(sent).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it("sends create folder and delete with an identity and maps agent errors", async () => {
    const { client, sent } = fakeClient({
      capabilities: all,
      reply: (frame) =>
        frame.type === "createDirectoryRequest"
          ? {
              type: "createDirectoryResponse",
              value: {
                requestId: frame.value.requestId,
                operationId: frame.value.operationId,
                terminal: true,
                errorCode: "ALREADY_EXISTS",
                errorMessage: "workspace file already exists",
              },
            }
          : frame.type === "deleteEntryRequest" && frame.value.path === "gone"
            ? {
                type: "deleteEntryResponse",
                value: {
                  requestId: frame.value.requestId,
                  operationId: frame.value.operationId,
                  terminal: true,
                  errorCode: "NOT_FOUND",
                  errorMessage: "missing",
                  deletedKind: "",
                },
              }
            : {
                type: "deleteEntryResponse",
                value: {
                  requestId: frame.type === "deleteEntryRequest" ? frame.value.requestId : "",
                  operationId: "op",
                  terminal: true,
                  errorCode: "",
                  errorMessage: "",
                  deletedKind: "directory",
                },
              },
    });
    const { mutations } = make(client);
    const exists = await failure(
      mutations.createDirectory({ cwd, executionTargetId: target, relativePath: "src/new" }),
    );
    expect(exists).toMatchObject({
      detail: WORKSPACE_ENTRY_ALREADY_EXISTS,
      writeDisposition: "terminal",
    });
    const missing = await failure(
      mutations.deleteEntry({
        cwd,
        executionTargetId: target,
        relativePath: "gone",
        expectedKind: "file",
      }),
    );
    expect(missing).toMatchObject({ detail: WORKSPACE_ENTRY_NOT_FOUND });
    const deleted = await Effect.runPromise(
      mutations.deleteEntry({
        cwd,
        executionTargetId: target,
        operationId: "delete-1",
        relativePath: "src",
        expectedKind: "directory",
      }),
    );
    expect(deleted).toEqual({ relativePath: "src", disposition: "deleted" });
    const last = sent.at(-1);
    expect(last).toMatchObject({
      type: "deleteEntryRequest",
      value: { operationId: "delete-1", path: "src", expectedKind: "directory" },
    });
    expect(last?.type === "deleteEntryRequest" && last.value.requestDigest.byteLength).toBe(32);
  });

  it("reports a lost connection after dispatch as an unknown outcome", async () => {
    const { client } = fakeClient({
      capabilities: all,
      reply: () => Promise.reject(new Error("socket closed")),
    });
    const error = await failure(
      make(client).mutations.deleteEntry({
        cwd,
        executionTargetId: target,
        relativePath: "src",
        expectedKind: "directory",
      }),
    );
    expect(error).toMatchObject({ writeDisposition: "unknown" });
  });
});
