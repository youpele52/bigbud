import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import type { TerminalSessionSnapshot } from "@bigbud/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { TerminalManagerShape } from "../Services/Manager";
import { withTerminalPasteStaging } from "./Manager.pasteStaging.attach.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function fakeManager(): TerminalManagerShape {
  const snapshot = {
    threadId: "thread-1",
    terminalId: "default",
    executionTargetId: "local",
    runtimeGeneration: "gen-1",
    status: "running",
  } as unknown as TerminalSessionSnapshot;
  return {
    snapshot: () => Effect.succeed(snapshot),
    close: () => Effect.void,
    restart: () => Effect.succeed(snapshot),
  } as unknown as TerminalManagerShape;
}

const stageFile = (manager: TerminalManagerShape) =>
  Effect.gen(function* () {
    const begun = yield* manager.stagePasteFile!({
      op: "begin",
      threadId: "thread-1",
      terminalId: "default",
      fileName: "a.png",
      mimeType: "image/png",
      byteLength: PNG.byteLength,
    });
    if (begun.op !== "begin") throw new Error("expected begin");
    yield* manager.stagePasteFile!({
      op: "chunk",
      uploadId: begun.uploadId,
      offset: 0,
      data: PNG.toString("base64"),
    });
    const committed = yield* manager.stagePasteFile!({ op: "commit", uploadId: begun.uploadId });
    if (committed.op !== "commit") throw new Error("expected commit");
    return committed.path;
  });

describe("withTerminalPasteStaging", () => {
  it("deletes a terminal's staged files when it closes or restarts", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "bigbud-paste-attach-"));
    roots.push(stateDir);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* withTerminalPasteStaging(fakeManager(), {
            stateDir,
            maxFileMb: () => undefined,
            remote: undefined,
          });
          const closed = yield* stageFile(manager);
          expect(
            closed.startsWith(
              path.join(yield* Effect.promise(() => fs.realpath(stateDir)), "terminal-paste"),
            ),
          ).toBe(true);
          yield* manager.close({ threadId: "thread-1", terminalId: "default" });
          expect(
            yield* Effect.promise(() =>
              fs.stat(closed).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
          const restarted = yield* stageFile(manager);
          yield* manager.restart({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/",
          } as never);
          expect(
            yield* Effect.promise(() =>
              fs.stat(restarted).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
        }),
      ),
    );
  });
});
