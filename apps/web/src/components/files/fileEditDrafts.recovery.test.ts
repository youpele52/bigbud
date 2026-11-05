import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changeFileEditDraft,
  discardConflictedFileEditDraft,
  fileEditKey,
  getFileEditDraft,
  getFileEditReadEpoch,
  invalidateFileEditRead,
  observeFileEditRead,
  retryFileEditDraft,
} from "./fileEditDrafts";

const write = vi.hoisted(() => vi.fn());
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { writeFile: write } }),
}));

const baseHash = "a".repeat(64);
const draftHash = "7743ce348d9284d677a185f33295b92266cc435a5b5f775029b300066d26693a";
function fixture() {
  const cwd = `/workspace/${crypto.randomUUID()}`;
  const relativePath = "file.txt";
  const key = fileEditKey(cwd, relativePath);
  observeFileEditRead({ cwd, relativePath, contents: "old", sha256: baseHash });
  return { cwd, relativePath, key };
}

async function failSave(input: ReturnType<typeof fixture>) {
  changeFileEditDraft(input.key, "draft");
  await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("error"), {
    timeout: 5000,
  });
}

afterEach(() => write.mockReset());

describe("file edit recovery", () => {
  it.each(["old", "draft"])("never retries an unknown write after reading %s", async (contents) => {
    write.mockRejectedValueOnce(new Error("Response lost"));
    const input = fixture();
    await failSave(input);
    observeFileEditRead({ ...input, contents, sha256: contents === "old" ? baseHash : draftHash });
    discardConflictedFileEditDraft(input.key);
    expect(getFileEditDraft(input.key)?.contents).toBe("draft");
    changeFileEditDraft(input.key, "newer draft");
    retryFileEditDraft(input.key);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(write).toHaveBeenCalledTimes(1);
    expect(getFileEditDraft(input.key)).toMatchObject({ contents: "newer draft", status: "error" });
  });

  it("uses a new identity after a terminal failure and fresh verification", async () => {
    write
      .mockRejectedValueOnce(Object.assign(new Error("Denied"), { writeDisposition: "terminal" }))
      .mockResolvedValue(undefined);
    const input = fixture();
    await failSave(input);
    retryFileEditDraft(input.key);
    expect(getFileEditDraft(input.key)?.status).toBe("error");
    observeFileEditRead({ ...input, contents: "old", sha256: baseHash });
    retryFileEditDraft(input.key);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(write.mock.calls[1]![0].operationId).not.toBe(write.mock.calls[0]![0].operationId);
  });

  it("does not treat a pre-settlement read as verification", async () => {
    write.mockRejectedValueOnce(
      Object.assign(new Error("Denied"), { writeDisposition: "terminal" }),
    );
    const input = fixture();
    const staleEpoch = getFileEditReadEpoch(input.key);
    await failSave(input);
    observeFileEditRead({ ...input, contents: "old", sha256: baseHash, readEpoch: staleEpoch });
    retryFileEditDraft(input.key);
    expect(getFileEditDraft(input.key)).toMatchObject({
      status: "error",
      retryAllowed: false,
      needsVerification: true,
    });
    expect(write).toHaveBeenCalledOnce();
  });

  it("restores safe retry for a reduced oversized draft after a failed refresh", async () => {
    const input = fixture();
    changeFileEditDraft(input.key, "x".repeat(512 * 1024 + 1));
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("error"), {
      timeout: 5000,
    });
    invalidateFileEditRead(input.key);
    changeFileEditDraft(input.key, "reduced");
    observeFileEditRead({ ...input, contents: "old", sha256: baseHash });
    expect(getFileEditDraft(input.key)?.retryAllowed).toBe(true);
    write.mockResolvedValueOnce(undefined);
    retryFileEditDraft(input.key);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(write.mock.calls[0]![0].contents).toBe("reduced");
  });

  it("advances a settled attempted snapshot without losing newer draft contents", async () => {
    let rejectWrite!: (cause: unknown) => void;
    write.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectWrite = reject;
        }),
    );
    const input = fixture();
    changeFileEditDraft(input.key, "draft");
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce(), { timeout: 5000 });
    changeFileEditDraft(input.key, "newer draft");
    rejectWrite(
      Object.assign(new Error("Directory sync failed"), { writeDisposition: "terminal" }),
    );
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("error"));
    observeFileEditRead({ ...input, contents: "draft", sha256: draftHash });
    expect(getFileEditDraft(input.key)).toMatchObject({
      contents: "newer draft",
      baseContents: "draft",
      baseHash: draftHash,
      status: "error",
      retryAllowed: true,
    });
    expect(write).toHaveBeenCalledOnce();
    invalidateFileEditRead(input.key);
    observeFileEditRead({ ...input, contents: "draft", sha256: draftHash });
    expect(getFileEditDraft(input.key)?.retryAllowed).toBe(true);
    write.mockResolvedValueOnce(undefined);
    retryFileEditDraft(input.key);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(write.mock.calls[1]![0]).toMatchObject({
      contents: "newer draft",
      expectedSha256: draftHash,
    });
    expect(write.mock.calls[1]![0].operationId).not.toBe(write.mock.calls[0]![0].operationId);
  });

  it("does not falsely announce an unknown write as saved when its bytes appear", async () => {
    write.mockRejectedValueOnce(new Error("Response lost"));
    const input = fixture();
    await failSave(input);
    observeFileEditRead({ ...input, contents: "draft", sha256: draftHash });
    expect(getFileEditDraft(input.key)).toMatchObject({
      contents: "draft",
      status: "error",
      retryAllowed: false,
    });
    retryFileEditDraft(input.key);
    expect(write).toHaveBeenCalledOnce();
  });
});
