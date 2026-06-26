import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { useComposerDraftStore } from "./composer.store";
import type { ComposerAnnotationAttachment } from "./types.store";
import {
  makeAnnotation,
  makeCodeAnnotation,
  makeImage,
  makeTerminalAnnotation,
  resetComposerDraftStore,
} from "./composer.store.test.utils";

describe("composerDraftStore annotations", () => {
  const threadId = ThreadId.makeUnsafe("thread-annotation");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores annotations independently from prompt text", () => {
    useComposerDraftStore
      .getState()
      .addAnnotation(threadId, makeAnnotation({ id: "annotation-1", imageId: "image-1" }));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.prompt).toBe("");
    expect(draft?.annotations.map((annotation) => annotation.id)).toEqual(["annotation-1"]);
  });

  it("removes annotations when their screenshot image is removed", () => {
    const image = makeImage({ id: "image-1", previewUrl: "blob:image-1" });
    useComposerDraftStore.getState().addImage(threadId, image);
    useComposerDraftStore
      .getState()
      .addAnnotation(threadId, makeAnnotation({ id: "annotation-1", imageId: image.id }));

    useComposerDraftStore.getState().removeImage(threadId, image.id);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("keeps code annotations when screenshot images are removed", () => {
    const image = makeImage({ id: "image-1", previewUrl: "blob:image-1" });
    const codeAnnotation = makeCodeAnnotation({ id: "code-annotation-1" });
    useComposerDraftStore.getState().addImage(threadId, image);
    useComposerDraftStore.getState().addAnnotation(threadId, codeAnnotation);

    useComposerDraftStore.getState().removeImage(threadId, image.id);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images).toEqual([]);
    expect(draft?.annotations).toEqual([codeAnnotation]);
  });

  it("stores terminal annotations independently from prompt text", () => {
    const terminalAnnotation = makeTerminalAnnotation({ id: "terminal-annotation-1" });
    useComposerDraftStore.getState().addAnnotation(threadId, terminalAnnotation);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.prompt).toBe("");
    expect(draft?.annotations).toEqual([terminalAnnotation]);
  });

  it("persists annotations with draft metadata", () => {
    const annotation = makeAnnotation({ id: "annotation-1", imageId: "image-1" });
    useComposerDraftStore.getState().addAnnotation(threadId, annotation);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<string, { annotations?: ComposerAnnotationAttachment[] }>;
    };

    expect(persistedState.draftsByThreadId?.[threadId]?.annotations).toEqual([annotation]);
  });

  it("normalizes malformed browser annotations before storing them", () => {
    const annotation = {
      id: "annotation-1",
      imageId: "image-1",
      comment: undefined,
      intent: "context",
      page: undefined,
      element: undefined,
      viewport: undefined,
      createdAt: "2026-05-02T00:00:00.000Z",
    } as unknown as ComposerAnnotationAttachment;

    useComposerDraftStore.getState().addAnnotation(threadId, annotation);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.annotations).toEqual([
      {
        id: "annotation-1",
        imageId: "image-1",
        comment: "",
        intent: "context",
        page: {
          title: "",
          url: "",
        },
        element: {
          selector: "",
          tag: "unknown",
          role: "",
          text: "",
          ariaLabel: null,
          id: null,
          className: "",
          rect: { x: 0, y: 0, width: 0, height: 0 },
        },
        viewport: { width: 0, height: 0, devicePixelRatio: 0 },
        createdAt: "2026-05-02T00:00:00.000Z",
      },
    ]);
  });
});
