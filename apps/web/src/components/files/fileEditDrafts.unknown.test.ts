import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changeFileEditDraft,
  fileEditKey,
  getFileEditDraft,
  keepMineFileEditDraft,
  observeFileEditRead,
  retryFileEditDraft,
} from "./fileEditDrafts";

const write = vi.hoisted(() => vi.fn());
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { writeFile: write } }),
}));

const baseHash = "a".repeat(64);
const otherHash = "b".repeat(64);
const draftHash = "7743ce348d9284d677a185f33295b92266cc435a5b5f775029b300066d26693a";

function fixture() {
  const cwd = `/workspace/${crypto.randomUUID()}`;
  const relativePath = "file.txt";
  const key = fileEditKey(cwd, relativePath);
  observeFileEditRead({ cwd, relativePath, contents: "old", sha256: baseHash });
  return { cwd, relativePath, key };
}

async function unknownSave(input: ReturnType<typeof fixture>) {
  write.mockRejectedValueOnce(
    Object.assign(new Error("Response lost"), { writeDisposition: "unknown" }),
  );
  changeFileEditDraft(input.key, "draft");
  await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("error"), {
    timeout: 5000,
  });
}

afterEach(() => write.mockReset());

describe("unknown save outcome", () => {
  it("cannot be retried before a fresh read", async () => {
    const input = fixture();
    await unknownSave(input);
    retryFileEditDraft(input.key);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("is marked saved when the read shows the attempted bytes", async () => {
    const input = fixture();
    await unknownSave(input);
    observeFileEditRead({ ...input, contents: "draft", sha256: draftHash });
    expect(getFileEditDraft(input.key)).toMatchObject({
      status: "saved",
      baseHash: draftHash,
      baseContents: "draft",
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("allows a new guarded save against the original hash when the original bytes remain", async () => {
    write.mockResolvedValue({ relativePath: "file.txt" });
    const input = fixture();
    await unknownSave(input);
    observeFileEditRead({ ...input, contents: "old", sha256: baseHash });
    expect(getFileEditDraft(input.key)).toMatchObject({ status: "error", retryAllowed: true });
    retryFileEditDraft(input.key);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const [first, second] = write.mock.calls.map((call) => call[0]);
    expect(second.expectedSha256).toBe(baseHash);
    expect(second.operationId).not.toBe(first.operationId);
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("saved"));
  });

  it("becomes a conflict when the read shows someone else's change", async () => {
    const input = fixture();
    await unknownSave(input);
    observeFileEditRead({ ...input, contents: "theirs", sha256: otherHash });
    expect(getFileEditDraft(input.key)).toMatchObject({
      status: "conflict",
      contents: "draft",
      diskVerified: true,
    });
  });
});

describe("keep mine", () => {
  it("overwrites only the disk version the user was shown", async () => {
    write.mockResolvedValue({ relativePath: "file.txt" });
    const input = fixture();
    await unknownSave(input);
    observeFileEditRead({ ...input, contents: "theirs", sha256: otherHash });
    keepMineFileEditDraft(input.key, otherHash);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(write.mock.calls[1]![0]).toMatchObject({ contents: "draft", expectedSha256: otherHash });
  });

  it("does nothing until the conflicting version has been read", () => {
    const input = fixture();
    keepMineFileEditDraft(input.key, baseHash);
    expect(getFileEditDraft(input.key)?.status).toBe("saved");
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses when a refresh moved the disk version after it was shown", async () => {
    const input = fixture();
    await unknownSave(input);
    observeFileEditRead({ ...input, contents: "theirs", sha256: otherHash });
    observeFileEditRead({ ...input, contents: "newer", sha256: "e".repeat(64) });
    keepMineFileEditDraft(input.key, otherHash);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(write).toHaveBeenCalledTimes(1);
    expect(getFileEditDraft(input.key)?.status).toBe("conflict");
  });
});

describe("reported result hash", () => {
  it("does not mark a save as saved when the backend reports different bytes", async () => {
    write.mockResolvedValue({ relativePath: "file.txt", resultSha256: otherHash });
    const input = fixture();
    changeFileEditDraft(input.key, "draft");
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("error"), {
      timeout: 5000,
    });
    expect(getFileEditDraft(input.key)).toMatchObject({
      needsVerification: true,
      retryAllowed: false,
    });
    observeFileEditRead({ ...input, contents: "draft", sha256: draftHash });
    expect(getFileEditDraft(input.key)?.status).toBe("saved");
  });
});
