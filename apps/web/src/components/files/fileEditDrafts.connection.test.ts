import { afterEach, describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import {
  changeFileEditDraft,
  fileEditKey,
  forgetFileEditDraftsForWorkspace,
  getFileEditDraft,
  observeFileEditRead,
} from "./fileEditDrafts";
import { SAVES_PAUSED_MESSAGE } from "./fileEditDrafts.connection";

const write = vi.hoisted(() => vi.fn());
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { writeFile: write } }),
}));

const target = "ssh:host=dev&transport=agent";
const baseHash = "a".repeat(64);

function open() {
  const cwd = `/workspace/${crypto.randomUUID()}`;
  const relativePath = "file.txt";
  observeFileEditRead({
    cwd,
    relativePath,
    executionTargetId: target,
    contents: "old",
    sha256: baseHash,
  });
  return {
    cwd,
    relativePath,
    executionTargetId: target,
    key: fileEditKey(cwd, relativePath, target),
  };
}

afterEach(() => {
  useRemoteAccessStore.getState().clearExecutionTargetDisconnected(target);
  write.mockReset();
});

describe("saves while a host is disconnected", () => {
  it("pauses autosave without dispatching, then resumes only after Connect and a fresh read", async () => {
    write.mockResolvedValue({ relativePath: "file.txt" });
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(target);
    const input = open();
    changeFileEditDraft(input.key, "draft");
    await vi.waitFor(
      () => expect(getFileEditDraft(input.key)?.message).toBe(SAVES_PAUSED_MESSAGE),
      {
        timeout: 5000,
      },
    );
    expect(write).not.toHaveBeenCalled();

    useRemoteAccessStore.getState().clearExecutionTargetDisconnected(target);
    expect(getFileEditDraft(input.key)).toMatchObject({
      needsVerification: true,
      status: "pending",
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(write).not.toHaveBeenCalled();

    observeFileEditRead({
      ...input,
      contents: "old",
      sha256: baseHash,
      readEpoch: getFileEditDraft(input.key)!.verificationEpoch,
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(write.mock.calls[0]![0]).toMatchObject({ contents: "draft", expectedSha256: baseHash });
  });

  it("turns a paused draft into a conflict when the host changed while disconnected", async () => {
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(target);
    const input = open();
    changeFileEditDraft(input.key, "draft");
    await vi.waitFor(
      () => expect(getFileEditDraft(input.key)?.message).toBe(SAVES_PAUSED_MESSAGE),
      {
        timeout: 5000,
      },
    );
    useRemoteAccessStore.getState().clearExecutionTargetDisconnected(target);
    observeFileEditRead({
      ...input,
      contents: "theirs",
      sha256: "b".repeat(64),
      readEpoch: getFileEditDraft(input.key)!.verificationEpoch,
    });
    expect(getFileEditDraft(input.key)?.status).toBe("conflict");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(write).not.toHaveBeenCalled();
  });
});

describe("removing a workspace", () => {
  it("drops its drafts", () => {
    const input = open();
    changeFileEditDraft(input.key, "draft");
    forgetFileEditDraftsForWorkspace(input.cwd, target);
    expect(getFileEditDraft(input.key)).toBeNull();
  });
});
