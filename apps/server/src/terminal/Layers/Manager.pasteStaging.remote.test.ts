import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type { TerminalSessionSnapshot } from "@bigbud/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "../../remote-agent/remoteAgentProtocol.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import { LocalPasteStore } from "./Manager.pasteStaging.local.ts";
import { makeRemotePasteAgentResolver } from "./Manager.pasteStaging.remote.ts";
import { makeTerminalPasteStaging } from "./Manager.pasteStaging.ts";
import { pasteStagingScope } from "./Manager.pasteStaging.target.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Answers paste frames like the Rust agent, recording what it received. */
function fakeAgent(options: { capability?: boolean; path?: string; beginError?: string } = {}) {
  const sent: RemoteAgentFrame[] = [];
  let received = 0;
  const connection = {
    supportsCapability: (name: string) =>
      options.capability !== false && name === "terminal.paste-staging",
    request: async (frame: RemoteAgentFrame) => {
      sent.push(frame);
      const requestId = (frame.value as { requestId: string }).requestId;
      const ok = { errorCode: "", errorMessage: "" };
      switch (frame.type) {
        case "pasteStageBeginRequest":
          return {
            type: "pasteStageBeginResponse",
            value: {
              requestId,
              uploadId: frame.value.uploadId,
              accepted: !options.beginError,
              maxChunkBytes: 4,
              errorCode: options.beginError ?? "",
              errorMessage: options.beginError ? "refused" : "",
            },
          };
        case "pasteStageChunkRequest":
          received += frame.value.data.byteLength;
          return {
            type: "pasteStageChunkResponse",
            value: { requestId, uploadId: frame.value.uploadId, receivedBytes: received, ...ok },
          };
        case "pasteStageCommitRequest":
          return {
            type: "pasteStageCommitResponse",
            value: {
              requestId,
              uploadId: frame.value.uploadId,
              path: options.path ?? "/home/dev/.bigbud/agent/paste/s/paste-0a1b.png",
              clipboard: "set",
              ...ok,
            },
          };
        case "pasteStageDiscardRequest":
          return { type: "pasteStageDiscardResponse", value: { requestId, removed: 1, ...ok } };
        default:
          throw new Error(`unexpected ${frame.type}`);
      }
    },
  } as unknown as RemoteAgentConnection;
  const adapter = {
    ownedRuntimeForTarget: (target: string) =>
      ({ targetId: target, pool: { get: async () => connection } }) as unknown as OwnedPtyRuntime,
  };
  return { sent, adapter };
}

function staging(target: string, resolver: ReturnType<typeof makeRemotePasteAgentResolver>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bigbud-remote-paste-"));
  roots.push(root);
  return makeTerminalPasteStaging({
    local: new LocalPasteStore(path.join(root, "terminal-paste")),
    snapshot: (input) =>
      Effect.succeed({
        threadId: input.threadId,
        terminalId: "default",
        executionTargetId: target,
        runtimeGeneration: "gen-7",
        status: "running",
      } as unknown as TerminalSessionSnapshot),
    maxFileBytes: () => 20 * 1024 * 1024,
    remote: resolver,
  });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function stageOnce(paste: ReturnType<typeof makeTerminalPasteStaging>) {
  const begun = await Effect.runPromise(
    paste.stage({
      op: "begin",
      threadId: "thread-1",
      terminalId: "default",
      fileName: "shot.png",
      mimeType: "image/png",
      byteLength: PNG.byteLength,
    }),
  );
  if (begun.op !== "begin") throw new Error("expected begin");
  await Effect.runPromise(
    paste.stage({ op: "chunk", uploadId: begun.uploadId, offset: 0, data: PNG.toString("base64") }),
  );
  return { begun, commit: paste.stage({ op: "commit", uploadId: begun.uploadId }) };
}

describe("terminal paste staging (remote agent)", () => {
  it("uploads to the session's host in agent-sized chunks and returns the agent's absolute path", async () => {
    const agent = fakeAgent();
    const paste = staging("ssh:vps.example", makeRemotePasteAgentResolver(agent.adapter));
    const { begun, commit } = await stageOnce(paste);
    expect(begun).toMatchObject({ host: "remote", hostLabel: "vps.example" });
    const committed = await Effect.runPromise(commit);
    expect(committed).toMatchObject({
      op: "commit",
      path: "/home/dev/.bigbud/agent/paste/s/paste-0a1b.png",
      clipboard: "set",
    });
    const begin = agent.sent.find((frame) => frame.type === "pasteStageBeginRequest");
    expect(begin?.value).toMatchObject({
      scope: pasteStagingScope("thread-1", "default", "gen-7"),
      extension: "png",
      imageMimeType: "image/png",
      totalBytes: PNG.byteLength,
    });
    const offsets = agent.sent
      .filter((frame) => frame.type === "pasteStageChunkRequest")
      .map((frame) => (frame.value as { offset: number }).offset);
    expect(offsets).toEqual([0, 4, 8]);
    const sha = agent.sent.find((frame) => frame.type === "pasteStageCommitRequest");
    expect(Buffer.from((sha!.value as { sha256: Uint8Array }).sha256).toString("hex")).toBe(
      createHash("sha256").update(PNG).digest("hex"),
    );
    await Effect.runPromise(paste.release("thread-1", "default"));
    expect(agent.sent.at(-1)).toMatchObject({
      type: "pasteStageDiscardRequest",
      value: { scope: pasteStagingScope("thread-1", "default", "gen-7"), uploadId: "" },
    });
  });

  it("asks for an agent update instead of dropping the file on old agents", async () => {
    const agent = fakeAgent({ capability: false });
    const paste = staging("ssh:old.example", makeRemotePasteAgentResolver(agent.adapter));
    const error = await Effect.runPromise(
      Effect.flip(
        paste.stage({
          op: "begin",
          threadId: "thread-1",
          terminalId: "default",
          fileName: "a.png",
          mimeType: "image/png",
          byteLength: 4,
        }),
      ),
    );
    expect(error.code).toBe("agentUpdateRequired");
    expect(error.message).toContain("old.example");
    expect(agent.sent).toEqual([]);
  });

  it("needs a remote agent for SSH-only terminals", async () => {
    const paste = staging(
      "ssh:host=plain.example&transport=direct-ssh",
      makeRemotePasteAgentResolver({ ownedRuntimeForTarget: () => undefined }),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        paste.stage({
          op: "begin",
          threadId: "thread-1",
          terminalId: "default",
          fileName: "a.png",
          mimeType: "image/png",
          byteLength: 4,
        }),
      ),
    );
    expect(error.code).toBe("remoteAgentRequired");
  });

  it("never pastes a relative path and maps agent size refusals", async () => {
    const relative = fakeAgent({ path: "paste/paste-0a1b.png" });
    const { commit } = await stageOnce(
      staging("ssh:vps.example", makeRemotePasteAgentResolver(relative.adapter)),
    );
    expect((await Effect.runPromise(Effect.flip(commit))).code).toBe("storageFailed");
    const refused = fakeAgent({ beginError: "TOO_LARGE" });
    const paste = staging("ssh:vps.example", makeRemotePasteAgentResolver(refused.adapter));
    const begun = await Effect.runPromise(
      paste.stage({
        op: "begin",
        threadId: "thread-1",
        terminalId: "default",
        fileName: "a.png",
        mimeType: "image/png",
        byteLength: PNG.byteLength,
      }),
    );
    if (begun.op !== "begin") throw new Error("expected begin");
    const error = await Effect.runPromise(
      Effect.flip(
        paste.stage({
          op: "chunk",
          uploadId: begun.uploadId,
          offset: 0,
          data: PNG.toString("base64"),
        }),
      ),
    );
    expect(error.code).toBe("tooLarge");
  });
});
