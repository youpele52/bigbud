import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changeFileEditDraft,
  discardConflictedFileEditDraft,
  fileEditKey,
  getFileEditDraft,
  observeFileEditRead,
  retryFileEditDraft,
  trackFileEditSession,
} from "./fileEditDrafts";

const write = vi.hoisted(() => vi.fn());
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { writeFile: write } }),
}));

const hash = "a".repeat(64);
function fixture() {
  const cwd = `/workspace/${crypto.randomUUID()}`;
  const relativePath = "src/example.ts";
  const key = fileEditKey(cwd, relativePath);
  observeFileEditRead({ cwd, relativePath, contents: "old", sha256: hash });
  return { cwd, relativePath, key };
}

afterEach(() => {
  write.mockReset();
});

describe("file edit drafts", () => {
  it("serializes writes and saves the latest revision with the newly acknowledged hash", async () => {
    let resolve!: () => void;
    write
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(undefined);
    const input = fixture();
    expect(getFileEditDraft(input.key)?.savedAt).toBeNull();
    changeFileEditDraft(input.key, "first");
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(write.mock.calls[0]![0]).toMatchObject({ contents: "first", expectedSha256: hash });
    changeFileEditDraft(input.key, "second");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(write).toHaveBeenCalledTimes(1);
    resolve();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(write.mock.calls[1]![0]).toMatchObject({
      contents: "second",
      expectedSha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e",
    });
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("saved"));
    expect(getFileEditDraft(input.key)?.savedAt).toBeGreaterThan(0);
  });

  it("retains uncertain writes without automatic retry even after reading the disk", async () => {
    write.mockRejectedValueOnce(new Error("Connection lost"));
    const input = fixture();
    changeFileEditDraft(input.key, "draft");
    await vi.waitFor(
      () =>
        expect(getFileEditDraft(input.key)).toMatchObject({ contents: "draft", status: "error" }),
      { timeout: 5000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(write).toHaveBeenCalledTimes(1);
    observeFileEditRead({ ...input, contents: "other", sha256: "b".repeat(64) });
    expect(getFileEditDraft(input.key)?.status).toBe("error");
  });

  it("does not replace a conflicted draft on further edits or refreshes", () => {
    const input = fixture();
    changeFileEditDraft(input.key, "local change");
    observeFileEditRead({ ...input, contents: "external", sha256: "b".repeat(64) });
    changeFileEditDraft(input.key, "newer local change");
    expect(getFileEditDraft(input.key)).toMatchObject({
      contents: "newer local change",
      status: "conflict",
    });
  });

  it("does not replace a clean open editor when the file changes externally", () => {
    const input = fixture();
    const leave = trackFileEditSession(input.key);
    observeFileEditRead({ ...input, contents: "external", sha256: "b".repeat(64) });
    expect(getFileEditDraft(input.key)).toMatchObject({ contents: "old", status: "conflict" });
    discardConflictedFileEditDraft(input.key);
    expect(getFileEditDraft(input.key)?.status).toBe("conflict");
    leave();
    discardConflictedFileEditDraft(input.key);
    expect(getFileEditDraft(input.key)).toMatchObject({ contents: "external", status: "saved" });
  });

  it("classifies server write conflicts and only permits discarding after reading the disk version", async () => {
    write.mockRejectedValueOnce(
      Object.assign(new Error("Workspace file changed since it was read."), {
        conflict: true,
        writeDisposition: "terminal",
      }),
    );
    const input = fixture();
    changeFileEditDraft(input.key, "draft");
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("conflict"), {
      timeout: 5000,
    });
    expect(getFileEditDraft(input.key)?.diskVerified).toBe(false);
    discardConflictedFileEditDraft(input.key);
    expect(getFileEditDraft(input.key)?.contents).toBe("draft");
    observeFileEditRead({ ...input, contents: "external", sha256: "b".repeat(64) });
    expect(getFileEditDraft(input.key)?.diskVerified).toBe(true);
    discardConflictedFileEditDraft(input.key);
    expect(getFileEditDraft(input.key)).toMatchObject({ contents: "external", status: "saved" });
  });

  it("only retries explicitly after a failed write", async () => {
    write
      .mockRejectedValueOnce(
        Object.assign(new Error("Not connected"), { writeDisposition: "not-dispatched" }),
      )
      .mockResolvedValue(undefined);
    const input = fixture();
    changeFileEditDraft(input.key, "draft");
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("error"), {
      timeout: 5000,
    });
    retryFileEditDraft(input.key);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(write.mock.calls[1]![0].operationId).not.toBe(write.mock.calls[0]![0].operationId);
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("saved"));
  });
});
