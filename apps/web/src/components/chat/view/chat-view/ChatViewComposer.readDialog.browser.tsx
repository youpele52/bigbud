import "../../../../index.css";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ThreadId,
  type ServerReadDocumentUrlResult,
} from "@bigbud/contracts";
import { useRef } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useComposerDraftStore, useComposerThreadDraft } from "../../../../stores/composer";
import { resetComposerDraftStore } from "../../../../stores/composer/composer.store.test.utils";
import { normalizePersistedDraftsByThreadId } from "../../../../stores/composer/normalizers.store";
import {
  partializeComposerDraftStoreState,
  toHydratedThreadDraft,
} from "../../../../stores/composer/persistence.store";
import { ComposerReadDialog } from "../../composer/ComposerReadDialog";
import { useComposerReadDialogState } from "../../composer/ComposerReadDialog.state";
import { ComposerFilePreviews } from "../../composer/ComposerFilePreviews";
import { useAddComposerFiles } from "../ChatView.composerHandlers.logic";
import { deferred } from "../ChatView.sendTurn.browser-helpers";
import { useChatViewComposerActions } from "./ChatViewComposer.actions";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";

const read = vi.hoisted(() =>
  vi.fn<
    (
      input: { url: string },
      options?: { signal?: AbortSignal },
    ) => Promise<ServerReadDocumentUrlResult>
  >(),
);
vi.mock("../../../../rpc/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../rpc/nativeApi")>()),
  readNativeApi: () => ({ server: { readDocumentUrl: read } }),
}));
vi.mock("../../../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const a = ThreadId.makeUnsafe("read-dialog-a");
const b = ThreadId.makeUnsafe("read-dialog-b");
const send = vi.fn();
const store = useComposerDraftStore.getState;
const result: ServerReadDocumentUrlResult = {
  sourceUrl: "https://example.com/document",
  resolvedUrl: "https://example.org/final",
  title: "Report",
  text: "Document body",
};

function Harness({ threadId }: { threadId: ThreadId }) {
  const draft = useComposerThreadDraft(threadId);
  const composerFilesRef = useRef(draft.files);
  composerFilesRef.current = draft.files;
  const state = useComposerReadDialogState(threadId);
  const addComposerFiles = useAddComposerFiles({
    activeThreadId: threadId,
    composerFilesRef,
    composerImagesLength: draft.images.length,
    addComposerFile: (file) => store().addFile(threadId, file),
    addComposerFilesToDraft: (files) => store().addFiles(threadId, files),
    setThreadError: vi.fn(),
    isElectron: false,
  });
  const actions = useChatViewComposerActions({
    base: state as ChatViewBaseState,
    runtime: {} as ChatViewRuntimeState,
    interactions: { addComposerFiles, onSend: send } as unknown as ChatViewInteractionsState,
  });
  return (
    <form
      onDrop={(event) => addComposerFiles(Array.from(event.dataTransfer.files))}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label="Draft"
        value={draft.prompt}
        onChange={(event) => store().setPrompt(threadId, event.target.value)}
      />
      <ComposerFilePreviews
        composerFiles={draft.files}
        resolvedTheme="light"
        onRemoveFile={(id) => store().removeFile(threadId, id)}
      />
      <button type="button" onClick={actions.onOpenReadDialog}>
        Open reader
      </button>
      <ComposerReadDialog
        key={threadId}
        open={state.readDocumentDialogOpen}
        onOpenChange={state.setReadDocumentDialogOpen}
        onSubmitFiles={actions.onSubmitReadFiles}
        onSubmitUrl={actions.onSubmitReadUrl}
      />
    </form>
  );
}

function chooseFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const selection = new DataTransfer();
  for (const file of files) selection.items.add(file);
  input.files = selection.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const dialog = () => page.getByRole("dialog", { name: "Read document or URL" });
const add = () => page.getByRole("button", { name: "Add to draft" });
const urlInput = () => page.getByRole("textbox", { name: "URL" });
const open = () => page.getByRole("button", { name: "Open reader" }).click();

beforeEach(() => {
  resetComposerDraftStore();
  store().setPrompt(a, "Keep my original draft");
  store().setPrompt(b, "Keep the other draft");
  read.mockReset();
  send.mockClear();
});

it("validates inline and stages URL contents without sending or replacing the draft", async () => {
  read.mockResolvedValue(result);
  await render(<Harness threadId={a} />);
  await open();
  await urlInput().fill("file:///report.txt");
  await expect.element(urlInput()).toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByText(/Enter a valid HTTP or HTTPS URL/)).toBeVisible();
  await expect.element(add()).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(read).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();

  await urlInput().fill(result.sourceUrl);
  await add().click();
  await expect.element(dialog()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("textbox", { name: "Draft" }))
    .toHaveValue("Keep my original draft");
  expect(read).toHaveBeenCalledExactlyOnceWith(
    { url: result.sourceUrl },
    { signal: expect.any(AbortSignal) },
  );
  expect(send).not.toHaveBeenCalled();
  const file = store().draftsByThreadId[a]?.files[0];
  expect(file).toMatchObject({
    readDocumentText: expect.stringContaining("Document body"),
    name: "Report.txt",
  });
  expect(await file?.file?.text()).toContain(
    `Resolved URL: ${result.resolvedUrl}\nTitle: Report\n\nDocument body`,
  );
  await page.getByRole("button", { name: "Remove Report.txt" }).click();
  expect(store().draftsByThreadId[a]?.files).toEqual([]);
});

it("round-trips a document-only draft through persisted storage without refetching", async () => {
  store().setPrompt(a, "");
  read.mockResolvedValueOnce(result);
  await render(<Harness threadId={a} />);
  await open();
  await urlInput().fill(result.sourceUrl);
  await add().click();
  await expect.element(dialog()).not.toBeInTheDocument();

  const saved = partializeComposerDraftStoreState(store());
  const normalized = normalizePersistedDraftsByThreadId(
    JSON.parse(JSON.stringify(saved.draftsByThreadId)),
  );
  const hydrated = toHydratedThreadDraft(normalized[a]!);
  expect(hydrated.prompt).toBe("");
  expect(hydrated.files).toHaveLength(1);
  expect(await hydrated.files[0]?.file?.text()).toBe(
    await store().draftsByThreadId[a]?.files[0]?.file?.text(),
  );
  expect(read).toHaveBeenCalledOnce();
});

it("does not attach a document dropped in the reader when it is cancelled", async () => {
  await render(<Harness threadId={a} />);
  await open();
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
  page
    .getByRole("button", { name: /Choose files or drag them here/ })
    .element()
    .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  await expect.element(add()).toBeEnabled();
  expect(store().draftsByThreadId[a]?.files).toEqual([]);
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(store().draftsByThreadId[a]?.files).toEqual([]);
});

it("keeps rejected local selections open and stages accepted files without sending", async () => {
  await render(<Harness threadId={a} />);
  await open();
  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  const tooLarge = new File([], "large.pdf");
  Object.defineProperty(tooLarge, "size", { value: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 });
  // Use the dialog's drag-and-drop route so the synthetic file metadata is preserved.
  const picker = page.getByRole("button", { name: /Choose files or drag them here/ }).element();
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [file, tooLarge] } });
  picker.dispatchEvent(drop);
  await add().click();
  await expect.element(page.getByRole("alert")).toHaveTextContent(/Could not attach these files/);
  await expect.element(dialog()).toBeVisible();
  expect(store().draftsByThreadId[a]?.files).toEqual([]);
  await page.getByRole("button", { name: "Cancel" }).click();
  await open();
  chooseFiles([file]);
  await add().click();
  await expect.element(dialog()).not.toBeInTheDocument();
  expect(store().draftsByThreadId[a]).toMatchObject({
    prompt: "Keep my original draft",
    files: [{ name: "notes.txt" }],
  });
  expect(read).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("aborts the RPC when the reader is cancelled", async () => {
  const cancelled = vi.fn();
  read.mockImplementationOnce(
    (_input, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(options.signal?.reason);
          },
          { once: true },
        );
      }),
  );
  await render(<Harness threadId={a} />);
  await open();
  await urlInput().fill(result.sourceUrl);
  await add().click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog()).not.toBeInTheDocument();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(store().draftsByThreadId[a]?.files).toEqual([]);
});

it("discards an in-flight URL result after navigation and does not close the next dialog", async () => {
  const stale = deferred<ServerReadDocumentUrlResult>();
  read.mockReturnValueOnce(stale.promise);
  const screen = await render(<Harness threadId={a} />);
  await open();
  await urlInput().fill(result.sourceUrl);
  await add().click();
  await screen.rerender(<Harness threadId={b} />);
  await expect.element(dialog()).not.toBeInTheDocument();
  await open();
  await urlInput().fill("https://example.com/new");
  stale.resolve(result);
  await stale.promise;
  await expect.element(dialog()).toBeVisible();
  await expect.element(urlInput()).toHaveValue("https://example.com/new");
  expect(store().draftsByThreadId[a]).toMatchObject({
    prompt: "Keep my original draft",
    files: [],
  });
  expect(store().draftsByThreadId[b]).toMatchObject({ prompt: "Keep the other draft", files: [] });
  expect(send).not.toHaveBeenCalled();
});

it("keeps the URL editable after a safe reader error", async () => {
  read.mockRejectedValueOnce(new Error("Only public document URLs are allowed."));
  await render(<Harness threadId={a} />);
  await open();
  await urlInput().fill(result.sourceUrl);
  await add().click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Only public document URLs are allowed.");
  await expect.element(urlInput()).toHaveValue(result.sourceUrl);
  await expect.element(add()).toBeEnabled();
  expect(send).not.toHaveBeenCalled();
});
