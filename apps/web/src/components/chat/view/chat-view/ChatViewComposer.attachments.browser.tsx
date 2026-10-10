import "../../../../index.css";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES, type ProviderKind } from "@bigbud/contracts";
import { providerAttachmentPolicy } from "@bigbud/shared/providerAttachments";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ComposerAttachmentMenu } from "../../composer/ComposerAttachmentMenu";
import { useChatViewInteractionFiles } from "./chat-view-interactions.files.hooks";
import { useChatViewComposerActions } from "./ChatViewComposer.actions";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { BIGBUD_FILES_PANEL_DRAG_MIME } from "../../../files/filesPanel.dnd";
import { BIGBUD_THREAD_CONTEXT_DRAG_MIME } from "../../../sidebar/threadPanel.dnd";

vi.mock("../../../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function AttachmentHarness(props: {
  provider: ProviderKind;
  base: ChatViewBaseState;
  runtime: ChatViewRuntimeState;
  capture: (
    files: ReturnType<typeof useChatViewInteractionFiles> & {
      submitReadFiles: (files: File[]) => Promise<void>;
    },
  ) => void;
}) {
  const files = useChatViewInteractionFiles({
    ...props,
    thread: { pendingUserInputs: [] } as unknown as ChatViewThreadDerivedState,
  });
  const actions = useChatViewComposerActions({
    base: props.base,
    runtime: props.runtime,
    interactions: {
      ...files,
      onSend: props.runtime.focusComposer,
    } as unknown as ChatViewInteractionsState,
  });
  props.capture({ ...files, submitReadFiles: actions.onSubmitReadFiles });
  const policy = providerAttachmentPolicy(props.provider);
  return (
    <>
      {!policy.supported && <p role="status">{policy.unavailableReason}</p>}
      <input
        aria-label="Upload"
        type="file"
        disabled={!policy.supported}
        onChange={files.onFileInputChange}
      />
      <ComposerAttachmentMenu
        onAttachFiles={files.onAttachFiles}
        onOpenReadDialog={vi.fn()}
        onCallAgent={vi.fn()}
        onUseSkill={vi.fn()}
        showAttachFiles={policy.supported}
        showReadDialog={policy.supported}
      />
    </>
  );
}

it("V2 attachment controls accept paste/drop/files without a default warning and toast only actual failures", async () => {
  const add = vi.fn(),
    error = vi.fn(),
    focus = vi.fn();
  const draft = [{ id: "retained", name: "retained.txt" }];
  const base = {
    activeThreadId: "draft",
    composerFilesRef: { current: draft },
    composerImagesRef: { current: [] },
    composerImages: [],
    addComposerFile: add,
    addComposerFilesToDraft: add,
    addComposerImage: add,
    addComposerImagesToDraft: add,
    dragDepthRef: { current: 0 },
    setIsDragOverComposer: vi.fn(),
  } as unknown as ChatViewBaseState;
  const runtime = {
    setThreadError: error,
    focusComposer: focus,
  } as unknown as ChatViewRuntimeState;
  let handlers!: ReturnType<typeof useChatViewInteractionFiles> & {
    submitReadFiles: (files: File[]) => Promise<void>;
  };
  const capture = (value: typeof handlers) => {
    handlers = value;
  };
  const screen = await render(
    <AttachmentHarness provider="opencodeV2" base={base} runtime={runtime} capture={capture} />,
  );
  try {
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    await expect.element(page.getByLabelText("Upload")).not.toBeDisabled();
    await page.getByRole("button", { name: "Add attachments, agents, or skills" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Add photos and files" }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("menuitem", { name: "Call agent" })).toBeInTheDocument();
    await expect.element(page.getByRole("menuitem", { name: "Use skill" })).toBeInTheDocument();
    const file = new File(["text"], "note.txt", { type: "text/plain" });
    const prevented = vi.fn();
    handlers.onComposerPaste({
      clipboardData: { files: [file] },
      preventDefault: prevented,
    } as never);
    handlers.onComposerPaste({
      clipboardData: { files: [new File(["x"], "image.png", { type: "image/png" })] },
      preventDefault: prevented,
    } as never);
    for (const type of ["Files", BIGBUD_FILES_PANEL_DRAG_MIME, BIGBUD_THREAD_CONTEXT_DRAG_MIME]) {
      handlers.onComposerDrop({
        dataTransfer: {
          types: [type],
          files: [file],
          getData: () =>
            JSON.stringify(
              type === BIGBUD_FILES_PANEL_DRAG_MIME
                ? { name: "workspace", path: "/workspace", entryKind: "directory" }
                : { threadId: "reference", title: "Reference context" },
            ),
        },
        preventDefault: prevented,
      } as never);
    }
    handlers.onFileInputChange({ target: { files: [file], value: "note.txt" } } as never);
    expect(handlers.addComposerFiles([file])).toBe(true);
    expect(focus).toHaveBeenCalled();
    expect(add).toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentMode: "path-reference", filePath: "/workspace" }),
    );
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentMode: "thread-reference", threadId: "reference" }),
    );
    const toast = (await import("../../../ui/toast")).toastManager.add;
    expect(toast).not.toHaveBeenCalled();
    const oversizedMetadata = new File(["x"], "too-large.txt", { type: "text/plain" });
    Object.defineProperty(oversizedMetadata, "size", {
      value: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
    });
    handlers.addComposerFiles([oversizedMetadata]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    focus.mockClear();
    await handlers.submitReadFiles([oversizedMetadata]);
    expect(focus).not.toHaveBeenCalled();
    expect(base.composerFilesRef.current).toBe(draft);
    expect(prevented).toHaveBeenCalledTimes(5);
    const pasteText = vi.fn();
    handlers.onComposerPaste({ clipboardData: { files: [] }, preventDefault: pasteText } as never);
    expect(pasteText).not.toHaveBeenCalled();
    await screen.rerender(
      <AttachmentHarness provider="opencode" base={base} runtime={runtime} capture={capture} />,
    );
    await expect.element(page.getByLabelText("Upload")).not.toBeDisabled();
    add.mockClear();
    handlers.addComposerFiles([file]);
    expect(add).toHaveBeenCalledOnce();
    expect(base.composerFilesRef.current).toBe(draft);
  } finally {
    await screen.unmount();
  }
});
