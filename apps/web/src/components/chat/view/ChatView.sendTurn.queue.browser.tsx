import {
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ServerReadDocumentUrlResult,
  type ThreadId,
} from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

import { createSendControl, deferred, installSendApi } from "./ChatView.sendTurn.browser-helpers";
import { QueueSendHarness } from "./ChatView.sendTurn.queue.browser-helpers";
import { MAX_QUEUED_PROMPTS } from "./ChatView.promptQueue.logic";
import { otherId, recentId, resetProjectGateStore } from "./ThreadProjectGate.test-helpers";
import { useComposerDraftStore } from "../../../stores/composer";
import {
  makeImage,
  resetComposerDraftStore,
} from "../../../stores/composer/composer.store.test.utils";
import { useStore } from "../../../stores/main";
import { resetWsConnectionStateForTests } from "../../../rpc/wsConnectionState";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
const draft = (id = recentId) => useComposerDraftStore.getState().draftsByThreadId[id];

beforeEach(() => {
  localStorage.clear();
  resetProjectGateStore();
  resetComposerDraftStore();
  resetWsConnectionStateForTests();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

it("offers normal chat Send alongside Stop while busy, but not while reconnecting", async () => {
  const api = await installSendApi();
  const control = createSendControl();
  mounted = await render(
    <QueueSendHarness threadId={recentId} control={control} overrides={{ isConnecting: true }} />,
  );
  const queue = page.getByRole("button", { name: "Queue message" });
  await expect.element(queue).toBeDisabled();
  await control.onSend();
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  expect(draft()?.prompt).toBe("Original follow-up");
  await mounted.rerender(<QueueSendHarness threadId={recentId} control={control} />);
  await expect.element(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await queue.click();
  await vi.waitFor(() =>
    expect(api.dispatchCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "thread.message.submit",
        threadId: recentId,
        delivery: "auto",
        message: expect.objectContaining({ text: "Original follow-up" }),
      }),
    ),
  );
});

it("keeps a busy-thread /read submission bound to its owner while preparation awaits navigation", async () => {
  const api = await installSendApi();
  const document = deferred<ServerReadDocumentUrlResult>();
  const read = vi.fn(() => document.promise);
  Object.assign(api.api, { server: { readDocumentUrl: read } });
  useComposerDraftStore.getState().setPrompt(recentId, "/read https://example.com/a");
  const control = createSendControl();
  mounted = await render(<QueueSendHarness threadId={recentId} control={control} />);
  const sending = control.onSend();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  // The destination queue is full: neither its owner nor capacity may replace A's binding.
  fillQueue(otherId);
  await mounted.rerender(<QueueSendHarness threadId={otherId} control={control} />);
  document.resolve({
    sourceUrl: "https://example.com/a",
    resolvedUrl: "https://example.com/a",
    title: "Document A",
    text: "Contents owned by A",
  });
  await sending;

  expect(api.dispatchCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "thread.message.submit",
      threadId: recentId,
      delivery: "auto",
      message: expect.objectContaining({ text: expect.stringContaining("Contents owned by A") }),
    }),
  );
  expect(draft()?.prompt ?? "").toBe("");
  expect(draft(otherId)?.prompt).toBe("Other thread draft");
  expect(control.input!.promptRef.current).toBe("Other thread draft");
});

it("admits a distinct queued prompt while an earlier submission awaits acknowledgment", async () => {
  const api = await installSendApi();
  const firstAck = deferred<{ sequence: number }>();
  api.dispatchCommand.mockReturnValueOnce(firstAck.promise);
  const control = createSendControl();
  mounted = await render(<QueueSendHarness threadId={recentId} control={control} />);
  const first = control.onSend();
  await vi.waitFor(() => expect(api.dispatchCommand).toHaveBeenCalledOnce());
  useComposerDraftStore.getState().setPrompt(recentId, "A second queued instruction");
  await vi.waitFor(() =>
    expect(control.input!.promptRef.current).toBe("A second queued instruction"),
  );
  await control.onSend();
  expect(api.dispatchCommand).toHaveBeenCalledTimes(2);
  expect(api.dispatchCommand.mock.calls[1]![0]).toMatchObject({
    type: "thread.message.submit",
    message: { text: "A second queued instruction" },
  });
  firstAck.resolve({ sequence: 11 });
  await first;
  expect(draft()?.prompt ?? "").toBe("");
});

it("deduplicates unchanged queue preparation without blocking a newer draft", async () => {
  const api = await installSendApi();
  const document = deferred<ServerReadDocumentUrlResult>();
  const read = vi.fn(() => document.promise);
  Object.assign(api.api, { server: { readDocumentUrl: read } });
  useComposerDraftStore.getState().setPrompt(recentId, "/read https://example.com/a");
  const control = createSendControl();
  mounted = await render(<QueueSendHarness threadId={recentId} control={control} />);
  const first = control.onSend();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await control.onSend();
  expect(read).toHaveBeenCalledOnce();
  useComposerDraftStore.getState().setPrompt(recentId, "A newer queued draft");
  await vi.waitFor(() => expect(control.input!.promptRef.current).toBe("A newer queued draft"));
  await control.onSend();
  expect(api.dispatchCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: expect.objectContaining({ text: "A newer queued draft" }) }),
  );
  document.resolve({
    sourceUrl: "https://example.com/a",
    resolvedUrl: "https://example.com/a",
    title: "Document A",
    text: "Prepared earlier instruction",
  });
  await first;
  expect(api.dispatchCommand).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "retains a refused document without losing a newer draft (at file limit: %s)",
  async (atFileLimit) => {
    const api = await installSendApi();
    const ack = deferred<{ sequence: number }>();
    api.dispatchCommand.mockReturnValueOnce(ack.promise);
    const contents = "Source URL: https://example.com/report\n\nThe staged report";
    const file = new File([contents], "Report.txt", { type: "text/plain" });
    const store = useComposerDraftStore.getState();
    store.setPrompt(recentId, "");
    store.addFile(recentId, {
      id: "staged-report",
      type: "file",
      attachmentMode: "upload",
      readDocumentText: contents,
      filePath: "",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    });
    const control = createSendControl();
    mounted = await render(<QueueSendHarness threadId={recentId} control={control} />);
    const submitting = control.onSend();
    await vi.waitFor(() => expect(api.dispatchCommand).toHaveBeenCalledOnce());
    expect(api.dispatchCommand.mock.lastCall?.[0]).toMatchObject({
      message: { text: "Use the attached files as context." },
    });
    store.setPrompt(recentId, "New draft text");
    const extraIds = Array.from(
      { length: atFileLimit ? PROVIDER_SEND_TURN_MAX_ATTACHMENTS : 0 },
      (_, i) => `new-file-${i}`,
    );
    for (const id of extraIds) {
      store.addFile(recentId, {
        id,
        type: "file",
        name: `${id}.txt`,
        mimeType: file.type,
        sizeBytes: file.size,
        filePath: "",
        file,
      });
    }
    await vi.waitFor(() => expect(control.input!.promptRef.current).toBe("New draft text"));
    ack.reject(new Error("Queue refused the document"));
    await submitting;
    expect(draft()?.prompt).toBe("New draft text");
    expect(draft()?.files.find((entry) => entry.id === "staged-report")?.file).toBe(file);

    if (atFileLimit) {
      await vi.waitFor(() =>
        expect(control.input?.composerFiles).toHaveLength(extraIds.length + 1),
      );
      await control.onSend();
      expect(api.dispatchCommand).toHaveBeenCalledOnce();
      expect(draft()?.files).toHaveLength(extraIds.length + 1);
      for (const id of extraIds) store.removeFile(recentId, id);
      await vi.waitFor(() => expect(control.input?.composerFiles).toHaveLength(1));
    }
    await control.onSend();
    expect(api.dispatchCommand).toHaveBeenCalledTimes(2);
    expect(api.dispatchCommand.mock.lastCall?.[0]).toMatchObject({
      message: {
        text: "New draft text",
        attachments: [
          { type: "file", name: "Report.txt", dataUrl: `data:text/plain;base64,${btoa(contents)}` },
        ],
      },
    });
  },
);

function fillQueue(threadId: ThreadId) {
  useStore.setState((state) => ({
    threads: state.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            queuedPrompts: Array.from({ length: MAX_QUEUED_PROMPTS }, (_, index) => ({
              id: MessageId.makeUnsafe(`${threadId}-${index}`),
              text: "Queued prompt",
              createdAt: thread.createdAt,
            })),
          }
        : thread,
    ),
  }));
}

function deferImageConversion() {
  const started = deferred<void>();
  const original = FileReader.prototype.readAsDataURL;
  let resume!: () => void;
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (
    this: FileReader,
    blob: Blob,
  ) {
    resume = () => original.call(this, blob);
    started.resolve();
  });
  useComposerDraftStore
    .getState()
    .addImage(recentId, makeImage({ id: "owner-image", previewUrl: "data:image/png;base64,AQ==" }));
  return { started: started.promise, resume: () => resume() };
}

it.each(["accepted", "rejected", "full"] as const)(
  "keeps converted attachments and draft recovery on the original owner when %s after navigation",
  async (outcome) => {
    const api = await installSendApi();
    if (outcome === "rejected") {
      api.dispatchCommand.mockRejectedValue(new Error("Queue refused A"));
    }
    if (outcome === "full") fillQueue(recentId);
    const conversion = deferImageConversion();
    const control = createSendControl();
    mounted = await render(<QueueSendHarness threadId={recentId} control={control} />);
    const sending = control.onSend();
    await conversion.started;
    expect(draft()?.prompt ?? "").toBe("");
    await mounted.rerender(<QueueSendHarness threadId={otherId} control={control} />);
    vi.clearAllMocks();
    conversion.resume();
    await sending;

    if (outcome === "full") {
      expect(api.dispatchCommand).not.toHaveBeenCalled();
    } else {
      expect(api.dispatchCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "thread.message.submit",
          threadId: recentId,
          delivery: "auto",
          message: expect.objectContaining({
            text: "Original follow-up",
            attachments: [expect.objectContaining({ type: "image", dataUrl: expect.any(String) })],
          }),
        }),
      );
    }
    expect(draft(otherId)?.prompt).toBe("Other thread draft");
    expect(control.input!.promptRef.current).toBe("Other thread draft");
    expect(control.ui.cursor).not.toHaveBeenCalled();
    expect(control.ui.optimistic).not.toHaveBeenCalled();
    if (outcome !== "accepted") {
      expect(draft()).toMatchObject({
        prompt: "Original follow-up",
        images: [{ id: "owner-image" }],
      });
      if (outcome === "rejected") {
        expect(useStore.getState().threads.find((thread) => thread.id === recentId)?.error).toBe(
          "Queue refused A",
        );
      }
    } else {
      expect(draft()?.prompt ?? "").toBe("");
      expect(draft()?.images ?? []).toEqual([]);
    }
  },
);
