import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";

it("normal local admission inlines managed uploads and ordinary workspace files without permitting neighboring paths", async () => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-media-app-")));
  const workspace = path.join(parent, "workspace");
  const uploads = path.join(parent, "uploads");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(uploads, { mode: 0o700 });
  const managed = {
    type: "file",
    id: "synthetic-upload",
    name: "upload.txt",
    mimeType: "text/plain",
    sizeBytes: 15,
  } as const;
  const source = {
    type: "file",
    id: "synthetic-workspace",
    name: "source.txt",
    sourcePath: path.join(workspace, "source.txt"),
    mimeType: "text/plain",
    sizeBytes: 16,
  } as const;
  const managedPath = resolveAttachmentPath({ attachmentsDir: uploads, attachment: managed });
  if (!managedPath) throw new Error("fixture attachment path unavailable");
  await writeFile(managedPath, "uploaded safely", { mode: 0o600 });
  await writeFile(source.sourcePath, "workspace safely", { mode: 0o600 });
  const neighbor = path.join(parent, "neighbor.txt");
  await writeFile(neighbor, "must not reach native", { mode: 0o600 });
  try {
    await withV2RuntimeFixture(async ({ runtime, http }) => {
      Object.assign(runtime.options, { allowLocalWorkspace: true, attachmentsDir: uploads });
      const threadId = ThreadId.makeUnsafe("application-media");
      const modelSelection = {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      } as const;
      await runtime.start({
        threadId,
        modelSelection,
        cwd: workspace,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("media"),
        input: "synthetic media",
        attachments: [managed, source],
      });
      const files = http.calls.find((call) => call.pathname.endsWith("/prompt"))?.body.files;
      expect(files).toEqual([
        {
          uri: `data:text/plain;base64,${Buffer.from("uploaded safely").toString("base64")}`,
          name: "upload.txt",
        },
        {
          uri: `data:text/plain;base64,${Buffer.from("workspace safely").toString("base64")}`,
          name: "source.txt",
        },
      ]);
      await expect(
        runtime.send({
          threadId,
          modelSelection,
          requestMessageId: MessageId.makeUnsafe("escape"),
          input: "must reject",
          attachments: [{ ...source, sourcePath: neighbor }],
        }),
      ).rejects.toThrow("escapes its authorized");
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      await writeFile(source.sourcePath, "changed workspace bytes", { mode: 0o600 });
      await expect(
        runtime.send({
          threadId,
          modelSelection,
          requestMessageId: MessageId.makeUnsafe("media"),
          input: "synthetic media",
          attachments: [managed, source],
        }),
      ).rejects.toThrow();
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
