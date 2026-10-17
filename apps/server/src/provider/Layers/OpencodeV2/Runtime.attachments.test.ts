import { mkdir, writeFile, rm, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import * as extraction from "../../../attachments/documentText.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { runtimePromptFingerprint } from "./Runtime.admission.ts";
import { prepareV2TurnAttachments } from "./Runtime.attachments.ts";

const selection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;
const threadId = ThreadId.makeUnsafe("attachments");
const attachment = {
  type: "file",
  id: "snapshot",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 7,
  sourcePath: "/never/reread/source",
} as const;

it("restores path-first context from managed bytes and replays after source/snapshot removal without reread/resend", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const attachmentsDir = path.join(directory, "uploads");
    await mkdir(attachmentsDir);
    Object.assign(runtime.options, { attachmentsDir });
    const snapshot = resolveAttachmentPath({ attachmentsDir, attachment })!;
    await writeFile(snapshot, "context");
    await runtime.start({
      threadId,
      modelSelection: selection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    const input = {
      threadId,
      requestMessageId: MessageId.makeUnsafe("document"),
      input: "summarize",
      modelSelection: selection,
      attachments: [attachment],
    };
    await runtime.send(input);
    await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
    const prompt = http.calls.find((call) => call.pathname.endsWith("/prompt"))!;
    expect(prompt.body.text).toContain(await realpath(snapshot));
    expect(prompt.body.text).toContain("context");
    expect(prompt.body.text).not.toContain(attachment.sourcePath);
    expect(String(prompt.body.text).match(/<attached_file_contents>/g)).toHaveLength(1);
    expect(prompt.body.files).toEqual([]);
    await rm(snapshot);
    await runtime.send(input);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    const owner = runtime.get(threadId);
    const originalBinding = owner.session;
    owner.session = { ...owner.session, workspaceExecutionTargetId: "ssh:changed-target" };
    await expect(prepareV2TurnAttachments(runtime.options, owner, input, true)).rejects.toThrow(
      "target binding changed",
    );
    owner.session = originalBinding;
    await expect(
      runtime.send({ ...input, attachments: [{ ...attachment, name: "changed.txt" }] }),
    ).rejects.toThrow("replay input changed");
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(
      (
        await Effect.runPromise(
          runtime.options.journal.find({
            namespace: "foreground",
            ownerThreadId: threadId,
            requestMessageId: input.requestMessageId,
          }),
        )
      )?.state,
    ).toBe("terminal");
  });
});

it("preparation rejects unreadable/invalid snapshots before model mutation/journal/quarantine", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    Object.assign(runtime.options, { attachmentsDir: directory });
    await runtime.start({
      threadId,
      modelSelection: selection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    const requestMessageId = MessageId.makeUnsafe("missing");
    await expect(
      runtime.send({
        threadId,
        requestMessageId,
        input: "retained",
        modelSelection: { ...selection, model: "second-model" },
        attachments: [attachment],
      }),
    ).rejects.toThrow("attachment preparation failed before admission");
    expect(
      http.calls.some(
        (call) =>
          call.method === "POST" &&
          (call.pathname.endsWith("/model") || call.pathname.endsWith("/prompt")),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        runtime.options.journal.find({
          namespace: "foreground",
          ownerThreadId: threadId,
          requestMessageId,
        }),
      ),
    ).toBeUndefined();
    expect(events.some((event) => JSON.stringify(event).includes("Admission unconfirmed"))).toBe(
      false,
    );
    await runtime.send({
      threadId,
      requestMessageId,
      input: "text works",
      modelSelection: selection,
    });
  });
});

it("delivers native image paths to image-capable models and OCR only to known visionless models", async () => {
  const ocr = vi
    .spyOn(extraction, "extractPromptTextFromBuffer")
    .mockResolvedValue("recognized text");
  try {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const bytes = await readFile(
        new URL("../../../../../web/public/favicon-16x16.png", import.meta.url),
      );
      const image = {
        type: "image",
        id: "visual",
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      } as const;
      Object.assign(runtime.options, { attachmentsDir: directory });
      await writeFile(
        resolveAttachmentPath({ attachmentsDir: directory, attachment: image })!,
        bytes,
      );
      Object.assign(http.models[0]!.capabilities, { input: ["text", "image"] });
      await runtime.start({
        threadId,
        modelSelection: selection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        requestMessageId: MessageId.makeUnsafe("vision"),
        input: "inspect",
        modelSelection: selection,
        attachments: [image],
      });
      await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
      const prompt = http.calls.find((call) => call.pathname.endsWith("/prompt"))!;
      expect(prompt.body.files).toEqual([
        { uri: expect.stringMatching(/^file:/), name: "pixel.png" },
      ]);
      expect(prompt.body.text).toContain("<attached_image_ocr>");
      Object.assign(http.models[0]!.capabilities, { input: ["text"] });
      await runtime.send({
        threadId,
        requestMessageId: MessageId.makeUnsafe("visionless"),
        input: "read",
        modelSelection: selection,
        attachments: [image],
      });
      const prompts = http.calls.filter((call) => call.pathname.endsWith("/prompt"));
      expect(prompts[1]!.body.files).toEqual([]);
      expect(prompts[1]!.body.text).toContain("recognized text");
      expect(ocr).toHaveBeenCalledTimes(2);
    });
  } finally {
    ocr.mockRestore();
  }
});

it("preserves historical empty remote reference text-only fingerprints without staging", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    await runtime.start({
      threadId,
      modelSelection: selection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    const media = vi.fn();
    Object.assign(runtime.get(threadId), { resources: { media, cleanup: async () => {} } });
    const input = {
      threadId,
      requestMessageId: MessageId.makeUnsafe("legacy"),
      input: "text works",
      modelSelection: selection,
    };
    await runtime.send(input);
    await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
    const prompt = http.calls.find((call) => call.pathname.endsWith("/prompt"))!;
    const expectedText =
      "text works\n\nbigbud workspace attachment references (target-bound metadata):\n[]";
    expect(prompt.body.text).toBe(expectedText);
    const metadata = prompt.body.metadata as Record<string, string>;
    const owner = runtime.get(threadId);
    expect(metadata.bigbud_fingerprint).toBe(
      runtimePromptFingerprint(
        expectedText,
        owner.model,
        createHash("sha256").update("[[],[]]").digest("hex"),
        owner.executionPolicy,
        metadata.bigbud_instruction_revision,
      ),
    );
    await runtime.send(input);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(media).not.toHaveBeenCalled();
  });
});
