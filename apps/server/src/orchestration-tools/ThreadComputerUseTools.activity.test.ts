import { ThreadId } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";

import { persistComputerUseScreenshot } from "./ThreadComputerUseTools.activity.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");
const screenshot = {
  mimeType: "image/png",
  dataBase64: Buffer.from("png-bytes").toString("base64"),
};

describe("persistComputerUseScreenshot", () => {
  it("reports completed attachment persistence", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });
        return yield* persistComputerUseScreenshot({
          attachmentsDir,
          fileSystem,
          path,
          threadId: THREAD_ID,
          result: { surface: "browser", action: "capture", summary: "Captured.", screenshot },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.attachmentPersistence).toEqual({ status: "completed" });
    expect(result.screenshot?.attachmentUrl).toMatch(/^\/attachments\//);
  });

  it("keeps a successful capture while reporting persistence degradation", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectory({ prefix: "computer-use-" });
        const blockedPath = path.join(tempDir, "not-a-directory");
        yield* fileSystem.writeFile(blockedPath, Uint8Array.from([1]));
        return yield* persistComputerUseScreenshot({
          attachmentsDir: blockedPath,
          fileSystem,
          path,
          threadId: THREAD_ID,
          result: { surface: "browser", action: "capture", summary: "Captured.", screenshot },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.summary).toBe("Captured.");
    expect(result.screenshot?.dataBase64).toBe(screenshot.dataBase64);
    expect(result.attachmentPersistence?.status).toBe("degraded");
    expect(result.attachmentPersistence?.message).toContain("persistence failed");
  });
});
