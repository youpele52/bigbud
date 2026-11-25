import "../../../index.css";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationQueuedPrompt } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { __resetNativeApiForTests } from "~/rpc/nativeApi";
import { recordWsConnectionOpened, resetWsConnectionStateForTests } from "~/rpc/wsConnectionState";
import { useComposerDraftStore } from "~/stores/composer";
import { usePromptQueue } from "./ChatView.promptQueue.logic";
import { ChatViewHeldPromptQueue } from "./chat-view/ChatViewHeldPromptQueue";

const threadId = ThreadId.makeUnsafe("held-recovery-browser");
const createdAt = "2026-11-23T00:00:00.000Z";
const replyId = MessageId.makeUnsafe("reply-target");
const prompt: OrchestrationQueuedPrompt = {
  id: MessageId.makeUnsafe("held-prompt"),
  createdAt,
  text: "Full original prompt\n\nincluding a second line.",
  attachments: [
    { type: "image", id: "stored-image", name: "image.png", mimeType: "image/png", sizeBytes: 1 },
  ],
  replyTo: { messageId: replyId, role: "assistant", createdAt, excerpt: "Quoted question" },
};

function Harness({ projected }: { projected: boolean }) {
  const queue = usePromptQueue({
    threadId,
    projectedPrompts: projected ? [prompt] : [],
    queueHold: true,
    activeTurnInProgress: false,
    onError: () => {},
    newId: () => "unused",
  });
  return (
    <AppAtomRegistryProvider>
      <ChatViewHeldPromptQueue threadId={threadId} queue={queue} canControl activeTurn={false} />
    </AppAtomRegistryProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete window.nativeApi;
  __resetNativeApiForTests();
  resetWsConnectionStateForTests();
  useComposerDraftStore.getState().clearComposerContent(threadId);
});

it("recovers the full stored submission once across an unknown outcome, and sends only on request", async () => {
  const dispatchCommand = vi.fn(async (_command: ClientOrchestrationCommand) => ({ sequence: 1 }));
  dispatchCommand.mockRejectedValueOnce(new Error("Disconnected after claim"));
  const getCommandOutcome = vi.fn(
    async (): Promise<{ status: string; resultSequence?: number }> => ({ status: "unknown" }),
  );
  window.nativeApi = { orchestration: { dispatchCommand, getCommandOutcome } } as never;
  __resetNativeApiForTests();
  useComposerDraftStore.getState().setPrompt(threadId, "Existing composer draft");
  const first = await render(<Harness projected />);
  const recover = page.getByRole("button", { name: "Recover queued prompt 1 to draft" });
  await expect.element(recover).toBeDisabled();
  useComposerDraftStore.getState().setPrompt(threadId, "");
  await recover.click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("not yet known");
  expect(dispatchCommand).toHaveBeenCalledTimes(1);
  expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
    type: "thread.queued-prompt.claim",
    messageId: prompt.id,
    promptCreatedAt: createdAt,
  });
  await first.unmount();

  const reopened = await render(<Harness projected={false} />);
  await page.getByRole("button", { name: "Retry recovery" }).click();
  await expect.element(page.getByText("Reply to: Quoted question")).toBeVisible();
  await expect.element(page.getByText("including a second line.", { exact: false })).toBeVisible();
  await expect.element(page.getByText("image.png")).toBeVisible();
  expect(dispatchCommand.mock.calls[1]?.[0]).toEqual(dispatchCommand.mock.calls[0]?.[0]);
  expect(dispatchCommand).toHaveBeenCalledTimes(2);

  dispatchCommand.mockRejectedValueOnce(new Error("Disconnected after send"));
  await page.getByRole("button", { name: "Send recovered message" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("not yet known");
  expect(dispatchCommand.mock.calls[2]?.[0]).toMatchObject({
    type: "thread.queued-prompt.recovered",
    action: "send",
    claimId: dispatchCommand.mock.calls[0]?.[0]?.commandId,
  });
  expect(dispatchCommand.mock.calls[2]?.[0]).not.toHaveProperty("message");
  getCommandOutcome.mockResolvedValue({ status: "accepted", resultSequence: 2 });
  recordWsConnectionOpened();
  await expect
    .element(page.getByRole("region", { name: "Recovered message draft" }))
    .not.toBeInTheDocument();
  expect(dispatchCommand).toHaveBeenCalledTimes(3);
  await reopened.unmount();
});

it("does not dispatch a claim when the browser cannot guarantee a strict transaction", async () => {
  const dispatchCommand = vi.fn();
  window.nativeApi = { orchestration: { dispatchCommand } } as never;
  __resetNativeApiForTests();
  const transaction = IDBDatabase.prototype.transaction;
  const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    stores: string | Iterable<string>,
    mode?: IDBTransactionMode,
  ) {
    return transaction.call(this, stores, mode, { durability: "relaxed" });
  });
  const view = await render(<Harness projected />);
  await page.getByRole("button", { name: "Recover queued prompt 1 to draft" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Strict recovered draft storage is unavailable");
  expect(spy).toHaveBeenCalledWith("held-drafts", "readwrite", { durability: "strict" });
  expect(dispatchCommand).not.toHaveBeenCalled();
  await view.unmount();
});
