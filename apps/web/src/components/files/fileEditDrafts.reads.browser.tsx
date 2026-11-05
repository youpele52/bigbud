import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import {
  changeFileEditDraft,
  discardConflictedFileEditDraft,
  invalidateFileEditRead,
  trackFileEditSession,
} from "./fileEditDrafts";
import { useFileEditDraft } from "./useFileEditDraft";
import { usePreviewLoad } from "./usePreviewLoad";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { readFilePreview: mocks.read, writeFile: mocks.write } }),
}));

const base = { contents: "old", sizeBytes: 3, sha256: "a".repeat(64), truncated: false };
const external = { contents: "external", sizeBytes: 8, sha256: "b".repeat(64), truncated: false };

function useEditingPreview(relativePath: string) {
  const loaded = usePreviewLoad({ cwd: "/workspace", relativePath });
  const { loadPreview } = loaded;
  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);
  const draft = useFileEditDraft({
    cwd: "/workspace",
    relativePath,
    preview: loaded.state,
    editing: false,
    refreshPreview: loaded.refreshPreview,
  });
  return { ...loaded, ...draft };
}

beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(base);
  mocks.write.mockReset().mockResolvedValue(undefined);
});

describe("fresh file edit verification", () => {
  it("keeps newer edits after an acknowledged save and rechecks overlapping reads before the next save", async () => {
    let finishWrite!: () => void;
    mocks.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const hook = await renderHook(() => useEditingPreview("acknowledged-read.txt"));
    try {
      await vi.waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      changeFileEditDraft(hook.result.current.draftKey, "draft");
      await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce(), { timeout: 5000 });
      changeFileEditDraft(hook.result.current.draftKey, "newer draft");
      await hook.result.current.refreshPreview();
      const savedHash = "7743ce348d9284d677a185f33295b92266cc435a5b5f775029b300066d26693a";
      mocks.read.mockResolvedValue({
        contents: "draft",
        sizeBytes: 5,
        sha256: savedHash,
        truncated: false,
      });
      finishWrite();
      await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2), { timeout: 5000 });
      expect(mocks.write.mock.calls[1]![0]).toMatchObject({
        contents: "newer draft",
        expectedSha256: savedHash,
      });
      await vi.waitFor(() => expect(hook.result.current.draft?.status).toBe("saved"));
      expect(hook.result.current.draft?.contents).toBe("newer draft");
      expect(mocks.read).toHaveBeenCalledTimes(3);
    } finally {
      finishWrite?.();
      await hook.unmount();
    }
  });

  it("supersedes a pre-settlement request instead of accepting its later response as proof", async () => {
    let failWrite!: (cause: unknown) => void;
    let finishOverlappingRead!: (value: typeof base) => void;
    let finishFreshRead!: (value: typeof base) => void;
    mocks.write.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failWrite = reject;
        }),
    );
    const hook = await renderHook(() => useEditingPreview("stale-read.txt"));
    try {
      await vi.waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      changeFileEditDraft(hook.result.current.draftKey, "draft");
      await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce(), { timeout: 5000 });
      mocks.read
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOverlappingRead = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishFreshRead = resolve;
            }),
        );
      const overlapping = hook.result.current.refreshPreview();
      failWrite(Object.assign(new Error("Rejected"), { writeDisposition: "terminal" }));
      await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(3));
      finishOverlappingRead(external);
      await overlapping;
      expect(hook.result.current.draft?.retryAllowed).toBe(false);
      expect(hook.result.current.draft?.diskVerified).toBe(false);
      finishFreshRead(base);
      await vi.waitFor(() => expect(hook.result.current.draft?.retryAllowed).toBe(true));
      expect(hook.result.current.draft?.status).toBe("error");
    } finally {
      await hook.unmount();
    }
  });

  it("re-reads an identical external version after an overlapping write settles", async () => {
    let failWrite!: (cause: unknown) => void;
    mocks.write.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failWrite = reject;
        }),
    );
    const hook = await renderHook(() => useEditingPreview("overlapping-read.txt"));
    try {
      await vi.waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      changeFileEditDraft(hook.result.current.draftKey, "draft");
      await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce(), { timeout: 5000 });
      mocks.read.mockResolvedValue(external);
      await hook.result.current.refreshPreview();
      const overlappingVersion = hook.result.current.state.readVersion;
      expect(hook.result.current.draft?.diskVerified).toBe(false);
      failWrite(Object.assign(new Error("Rejected"), { writeDisposition: "terminal" }));
      await vi.waitFor(() => expect(hook.result.current.draft?.diskVerified).toBe(true));
      expect(hook.result.current.draft).toMatchObject({ contents: "draft", status: "conflict" });
      expect(hook.result.current.state.readVersion).toBeGreaterThan(overlappingVersion);
      invalidateFileEditRead(hook.result.current.draftKey);
      await vi.waitFor(() => expect(hook.result.current.draft?.diskVerified).toBe(false));
      await hook.result.current.refreshPreview();
      await vi.waitFor(() => expect(hook.result.current.draft?.diskVerified).toBe(true));
    } finally {
      await hook.unmount();
    }
  });

  it("keeps a small retained draft recoverable when disk grows beyond the edit limit", async () => {
    const hook = await renderHook(() => useEditingPreview("oversized-recovery.txt"));
    try {
      await vi.waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      changeFileEditDraft(hook.result.current.draftKey, "small draft");
      const large = {
        contents: "x".repeat(512 * 1024 + 1),
        sizeBytes: 512 * 1024 + 1,
        sha256: "c".repeat(64),
        truncated: false,
      };
      mocks.read.mockResolvedValue(large);
      await hook.result.current.refreshPreview();
      await vi.waitFor(() => expect(hook.result.current.draft?.status).toBe("conflict"));
      expect(hook.result.current.eligible).toBe(true);
      expect(hook.result.current.draft?.contents).toBe("small draft");
      expect(hook.result.current.draft?.diskVerified).toBe(true);
      discardConflictedFileEditDraft(hook.result.current.draftKey);
      await vi.waitFor(() => expect(hook.result.current.eligible).toBe(false));
      expect(hook.result.current.draft?.contents).toBe(large.contents);
      expect(mocks.write).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it.each(["truncated", "failed"])(
    "does not verify a %s replacement or drop its retained draft",
    async (kind) => {
      const hook = await renderHook(() => useEditingPreview(`${kind}-recovery.txt`));
      try {
        await vi.waitFor(() => expect(hook.result.current.draft).not.toBeNull());
        const leaveEditor = trackFileEditSession(hook.result.current.draftKey);
        changeFileEditDraft(hook.result.current.draftKey, "small draft");
        mocks.read.mockResolvedValue(external);
        await hook.result.current.refreshPreview();
        await vi.waitFor(() => expect(hook.result.current.draft?.diskVerified).toBe(true));
        leaveEditor();
        if (kind === "truncated") mocks.read.mockResolvedValue({ ...external, truncated: true });
        else mocks.read.mockRejectedValue(new Error("Read failed"));
        await hook.result.current.refreshPreview();
        await vi.waitFor(() => expect(hook.result.current.draft?.diskVerified).toBe(false));
        discardConflictedFileEditDraft(hook.result.current.draftKey);
        expect(hook.result.current.draft?.contents).toBe("small draft");
        expect(hook.result.current.eligible).toBe(true);
      } finally {
        await hook.unmount();
      }
    },
  );
});
