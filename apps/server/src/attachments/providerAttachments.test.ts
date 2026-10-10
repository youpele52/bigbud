import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { prepareAttachmentContext } from "./providerAttachments.ts";
import {
  canReadManagedProviderPaths,
  prepareManagedAttachmentContext,
} from "./providerAttachments.managed.ts";
import { resolveAttachmentPath } from "./attachmentStore.ts";

const file = {
  type: "file",
  id: "snapshot",
  name: "note.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
  sourcePath: "/never/read/arbitrary",
} as const;

it("advertises host snapshot paths only when runtime and workspace reading tools are local", () => {
  expect(
    canReadManagedProviderPaths({
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
    }),
  ).toBe(true);
  expect(
    canReadManagedProviderPaths({
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "ssh:remote",
    }),
  ).toBe(false);
  expect(
    canReadManagedProviderPaths({
      providerRuntimeExecutionTargetId: "ssh:runtime",
      workspaceExecutionTargetId: "local",
    }),
  ).toBe(false);
  expect(canReadManagedProviderPaths({ executionTargetId: "ssh:legacy" })).toBe(false);
});

it("uses immutable managed content, one extracted block, and only reachable paths", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bigbud-attachments-")));
  try {
    const snapshot = resolveAttachmentPath({ attachmentsDir: root, attachment: file })!;
    await writeFile(snapshot, "text");
    const local = await prepareManagedAttachmentContext("prompt", [file], root);
    expect(local.text).toContain(snapshot);
    expect(local.text).not.toContain(file.sourcePath);
    expect(local.text.match(/<attached_file_contents>/g)).toHaveLength(1);
    const remote = await prepareManagedAttachmentContext("prompt", [file], root, false);
    expect(remote.text).not.toContain(snapshot);
    expect(remote.text).toContain("host path unavailable");
    expect(remote.text).toContain("text");
    expect(remote.digest).not.toBe(local.digest);
    await rm(snapshot);
    await symlink(path.join(root, "other"), snapshot);
    await writeFile(path.join(root, "other"), "text");
    await expect(prepareManagedAttachmentContext("prompt", [file], root)).rejects.toThrow(
      "identity rejected",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds supplemental aggregate text and explains failed extraction without pretending OCR is vision", async () => {
  const extract = vi
    .fn()
    .mockResolvedValueOnce("x".repeat(100000))
    .mockRejectedValueOnce(new Error("helper missing"));
  const image = { ...file, type: "image", mimeType: "image/png", name: "image.png" } as const;
  const result = await prepareAttachmentContext(
    "prompt",
    [
      { attachment: file, bytes: Buffer.from("text") },
      { attachment: image, bytes: Buffer.from("data") },
    ],
    extract,
  );
  expect(extract).toHaveBeenCalledTimes(2);
  expect(result.text.length).toBeLessThan(34000);
  expect(result.warnings).toContain("note.txt: supplemental extracted context was truncated.");
  expect(result.text).toContain("OCR is not equivalent to the original visual content");
  expect(result.text).toContain("helpers may be unavailable");
});
