import { expect, it } from "vitest";
import { Effect } from "effect";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { sharedV2FixtureOptions as sharedOptions } from "./SharedService.binding.fixture.ts";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import { resolveV2RuntimeBinding } from "./Runtime.binding.ts";

const modelSelection = {
  provider: "opencodeV2" as const,
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
};

it("mode-fences tagged isolated cursors but adopts exact untagged legacy IDs and immutable admissions", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory, http }) => {
    const attachmentsDir = path.join(directory, "uploads");
    const attachmentAdmissionsDir = path.join(
      runtime.options.config.profileRoot,
      "bigbud-attachment-admissions",
    );
    await mkdir(attachmentsDir);
    Object.assign(runtime.options, { attachmentsDir, attachmentAdmissionsDir });
    const attachment = {
      type: "file",
      id: "retained-context",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
    } as const;
    const upload = resolveAttachmentPath({ attachmentsDir, attachment })!;
    await writeFile(upload, "context");
    const input = {
      threadId: ThreadId.makeUnsafe("legacy-private"),
      cwd: directory,
      runtimeMode: "approval-required" as const,
      modelSelection,
    };
    const saved = await runtime.start(input);
    const send = {
      ...input,
      requestMessageId: MessageId.makeUnsafe("original"),
      input: "preserve original history",
      attachments: [attachment],
    };
    await runtime.send(send);
    await expect.poll(() => runtime.get(input.threadId).terminalDelivered).toBe(true);
    const original = await Effect.runPromise(runtime.options.journal.latestBound(input.threadId));
    const [prepared] = await readdir(attachmentAdmissionsDir);
    const preparation = await readFile(path.join(attachmentAdmissionsDir, prepared!));
    await rm(upload);
    const calls = http.calls.length;
    const shared = new OpencodeV2Runtime(sharedOptions(runtime, http));
    await expect(shared.start({ ...input, resumeCursor: saved.resumeCursor })).rejects.toThrow(
      "isolated history",
    );
    expect(http.calls).toHaveLength(calls);
    const adopted = await shared.start(input); // Legacy journal has no original mode provenance.
    expect(adopted.resumeCursor).toMatchObject({
      nativeSessionId: original!.binding.nativeSessionId,
      storageIdentity: original!.binding.storageIdentity,
      connectionMode: "shared",
    });
    await shared.send(send);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(await Effect.runPromise(runtime.options.journal.latestBound(input.threadId))).toEqual(
      original,
    );
    expect(await readFile(path.join(attachmentAdmissionsDir, prepared!))).toEqual(preparation);
    expect(
      http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
    ).toHaveLength(1);
    await shared.stop(input.threadId);
    await shared.close();
  });
});

it("a creation intent with no cursor/journal survives lost acknowledgement and missing history without recreate", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory, http }) => {
    const shared = new OpencodeV2Runtime(sharedOptions(runtime, http));
    const input = {
      threadId: ThreadId.makeUnsafe("lost-create"),
      cwd: directory,
      runtimeMode: "approval-required" as const,
      modelSelection,
    };
    http.loseCreateAck = true;
    await expect(shared.start(input)).rejects.toThrow();
    const intent = await Effect.runPromise(runtime.options.sharedBindings!.find(input.threadId));
    expect(intent?.state).toBe("dispatch-intent");
    // API-aware mode switching consults retained evidence before deriving an isolated identity.
    await expect(resolveV2RuntimeBinding(runtime.options, input)).rejects.toThrow(
      "retained shared history",
    );
    expect(
      await Effect.runPromise(runtime.options.journal.latestBound(input.threadId)),
    ).toBeUndefined();
    http.sessions.clear();
    http.loseCreateAck = false;
    const restarted = new OpencodeV2Runtime(sharedOptions(runtime, http));
    await expect(restarted.start(input)).rejects.toThrow("retained creation/admission intent");
    expect(await Effect.runPromise(runtime.options.sharedBindings!.find(input.threadId))).toEqual(
      intent,
    );
    expect(
      http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
    ).toHaveLength(1);
    await restarted.close();
    await shared.close().catch(() => {}); // Uncertain native mutation remains quarantined.
  });
});

it("an API-aware restart verifies surviving no-cursor create intent without dispatching create again", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory, http }) => {
    const first = new OpencodeV2Runtime(sharedOptions(runtime, http));
    const input = {
      threadId: ThreadId.makeUnsafe("surviving-create"),
      cwd: directory,
      runtimeMode: "approval-required" as const,
      modelSelection,
    };
    http.loseCreateAck = true;
    await expect(first.start(input)).rejects.toThrow();
    const original = await Effect.runPromise(runtime.options.sharedBindings!.find(input.threadId));
    expect(original?.state).toBe("dispatch-intent");
    http.loseCreateAck = false;
    const restarted = new OpencodeV2Runtime(sharedOptions(runtime, http));
    try {
      const recovered = await restarted.start(input);
      expect(recovered.resumeCursor).toMatchObject({
        nativeSessionId: original!.nativeSessionId,
        storageIdentity: original!.storageIdentity,
      });
      const verified = await Effect.runPromise(
        runtime.options.sharedBindings!.find(input.threadId),
      );
      expect(verified).toEqual({
        ...original,
        state: "verified",
        revision: original!.revision + 1,
      });
      expect(
        http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
      ).toHaveLength(1);
      expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
    } finally {
      await restarted.close();
      await first.close().catch(() => {});
    }
  });
});

it("failed cursor-only legacy adoption cannot become fresh creation when the caller later omits its cursor", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory, http }) => {
    const input = {
      threadId: ThreadId.makeUnsafe("cursor-only-legacy"),
      cwd: directory,
      runtimeMode: "approval-required" as const,
      modelSelection,
    };
    const original = await runtime.start(input);
    const {
      connectionMode: _mode,
      identityVersion: _version,
      ...legacy
    } = original.resumeCursor as {
      connectionMode: string;
      identityVersion: number;
      nativeSessionId: string;
    };
    http.sessions.clear();
    const first = new OpencodeV2Runtime(sharedOptions(runtime, http));
    await expect(first.start({ ...input, resumeCursor: legacy })).rejects.toThrow(
      "retained creation/admission intent",
    );
    const binding = await Effect.runPromise(runtime.options.sharedBindings!.find(input.threadId));
    expect(binding).toMatchObject({
      state: "reserved",
      identityKind: "adopted-legacy-v1",
      nativeSessionId: legacy.nativeSessionId,
    });
    const restarted = new OpencodeV2Runtime(sharedOptions(runtime, http));
    try {
      await expect(restarted.start(input)).rejects.toThrow("retained creation/admission intent");
      expect(await Effect.runPromise(runtime.options.sharedBindings!.find(input.threadId))).toEqual(
        binding,
      );
      expect(
        http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
      ).toHaveLength(1);
    } finally {
      await restarted.close();
      await first.close();
      http.die();
    }
  });
});
