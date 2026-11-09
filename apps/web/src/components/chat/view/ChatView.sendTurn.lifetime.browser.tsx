import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  SendHarness,
  createSendControl,
  deferred,
  installSendApi,
} from "./ChatView.sendTurn.browser-helpers";
import { recentId, otherId, resetProjectGateStore } from "./ThreadProjectGate.test-helpers";
import { useComposerDraftStore } from "../../../stores/composer";
import {
  makeImage,
  resetComposerDraftStore,
} from "../../../stores/composer/composer.store.test.utils";
import { readMaterializationLedger } from "../../../stores/materialization/materializationLedger";
import { useStore } from "../../../stores/main";
import { useRemoteAccessStore } from "../../../stores/remoteAccess/remoteAccess.store";
import { resetWsConnectionStateForTests } from "../../../rpc/wsConnectionState";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  useRemoteAccessStore.setState(useRemoteAccessStore.getInitialState(), true);
  localStorage.clear();
  resetProjectGateStore();
  resetComposerDraftStore();
  resetWsConnectionStateForTests();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});
const draft = (id = recentId) => useComposerDraftStore.getState().draftsByThreadId[id];
function attach() {
  const store = useComposerDraftStore.getState();
  store.addImage(
    recentId,
    makeImage({ id: "saved-image", previewUrl: "data:image/png;base64,AQ==" }),
  );
  store.addFile(recentId, {
    type: "file",
    id: "saved-file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    filePath: "",
    file: new File(["data"], "notes.txt"),
  });
}

it("single-flights the actual send before asynchronous ownership preflight completes", async () => {
  const api = await installSendApi();
  const ownership = deferred<Awaited<ReturnType<typeof api.resolveThreadOwnership>>>();
  api.resolveThreadOwnership.mockReturnValue(ownership.promise);
  const control = createSendControl();
  mounted = await render(
    <StrictMode>
      <SendHarness threadId={recentId} control={control} />
    </StrictMode>,
  );
  const first = control.onSend();
  await vi.waitFor(() => expect(api.resolveThreadOwnership).toHaveBeenCalledOnce());
  await control.onSend();
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  ownership.resolve({
    threadId: recentId,
    projectId: control.input!.activeThread!.projectId,
    status: "active",
    serverEpoch: "test-server",
    canonicalRevision: 10,
  });
  await first;
  expect(api.dispatchCommand).toHaveBeenCalledOnce();
});

it("does not clear edits or new attachments made during send preflight", async () => {
  const api = await installSendApi();
  const ownership = deferred<Awaited<ReturnType<typeof api.resolveThreadOwnership>>>();
  api.resolveThreadOwnership.mockReturnValue(ownership.promise);
  const control = createSendControl();
  mounted = await render(<SendHarness threadId={recentId} control={control} />);
  const first = control.onSend();
  await vi.waitFor(() => expect(api.resolveThreadOwnership).toHaveBeenCalledOnce());
  useComposerDraftStore.getState().setPrompt(recentId, "A newer draft");
  attach();
  await vi.waitFor(() => expect(control.input!.promptRef.current).toBe("A newer draft"));
  ownership.resolve({
    threadId: recentId,
    projectId: control.input!.activeThread!.projectId,
    status: "active",
    serverEpoch: "test-server",
    canonicalRevision: 10,
  });
  await first;
  expect(api.dispatchCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.objectContaining({ text: "Original follow-up", attachments: [] }),
    }),
  );
  expect(draft()).toMatchObject({
    prompt: "A newer draft",
    images: [{ id: "saved-image" }],
    files: [{ id: "saved-file" }],
  });
});

it("restores the old thread's text and attachments after navigation without mutating the new surface", async () => {
  const api = await installSendApi();
  attach();
  const acknowledgment = deferred<{ sequence: number }>();
  api.dispatchCommand.mockReturnValue(acknowledgment.promise);
  const control = createSendControl();
  mounted = await render(<SendHarness threadId={recentId} control={control} />);
  const first = control.onSend();
  await vi.waitFor(() => expect(api.dispatchCommand).toHaveBeenCalledOnce());
  expect(draft()?.prompt ?? "").toBe("");
  await mounted.rerender(<SendHarness threadId={otherId} control={control} />);
  control.input!.sendInFlightRef.current = true; // A new surface's independent dispatch owns this ref now.
  vi.clearAllMocks();
  acknowledgment.reject(new Error("lost acknowledgement"));
  await first;
  expect(draft()).toMatchObject({
    prompt: "Original follow-up",
    images: [{ id: "saved-image" }],
    files: [{ id: "saved-file" }],
  });
  expect(draft(otherId)?.prompt).toBe("Other thread draft");
  expect(control.input!.promptRef.current).toBe("Other thread draft");
  expect(control.input!.sendInFlightRef.current).toBe(true);
  expect(control.ui.reset).not.toHaveBeenCalled();
  expect(control.ui.cursor).not.toHaveBeenCalled();
  expect(control.ui.optimistic).not.toHaveBeenCalled();
});

it("reconciles a lost acknowledgment with the original command ID and never sends a duplicate", async () => {
  const api = await installSendApi();
  attach();
  api.dispatchCommand.mockRejectedValue(new Error("lost acknowledgement"));
  const control = createSendControl();
  mounted = await render(<SendHarness threadId={recentId} control={control} />);
  await control.onSend();
  const command = api.dispatchCommand.mock.calls[0]![0];
  const ledger = readMaterializationLedger();
  expect(ledger.status === "ready" && ledger.value.attemptsByThreadId[recentId]).toMatchObject({
    commandId: command.commandId,
    status: "ambiguous",
  });
  expect(draft()).toMatchObject({
    prompt: "Original follow-up",
    images: [{ id: "saved-image" }],
    files: [{ id: "saved-file" }],
  });
  api.getCommandOutcome.mockImplementation(async ({ commandId }) => ({
    commandId,
    status: "accepted",
    aggregateKind: "thread",
    aggregateId: recentId,
    resultSequence: 11,
    acceptedAt: "2026-11-09T00:00:00.000Z",
    serverEpoch: "test-server",
    canonicalRevision: 11,
  }));
  await vi.waitFor(() => expect(control.input!.promptRef.current).toBe("Original follow-up"));
  await control.onSend();
  expect(api.getCommandOutcome).toHaveBeenLastCalledWith({ commandId: command.commandId });
  expect(api.dispatchCommand).toHaveBeenCalledOnce();
  expect(draft()?.prompt).toBe("Original follow-up");
});

it.each(["navigate-back", "unmount"] as const)(
  "does not revive old surface authority after %s",
  async (action) => {
    const api = await installSendApi();
    const acknowledgment = deferred<{ sequence: number }>();
    api.dispatchCommand.mockReturnValue(acknowledgment.promise);
    const control = createSendControl();
    mounted = await render(<SendHarness threadId={recentId} control={control} />);
    const first = control.onSend();
    await vi.waitFor(() => expect(api.dispatchCommand).toHaveBeenCalledOnce());
    if (action === "unmount") {
      await mounted.unmount();
      mounted = undefined;
    } else {
      await mounted.rerender(<SendHarness threadId={otherId} control={control} />);
      await mounted.rerender(<SendHarness threadId={recentId} control={control} />);
      control.input!.sendInFlightRef.current = true;
    }
    vi.clearAllMocks();
    acknowledgment.reject(new Error("lost acknowledgment"));
    await first;
    expect(draft()?.prompt).toBe("Original follow-up");
    expect(control.ui.optimistic).not.toHaveBeenCalled();
    expect(control.ui.reset).not.toHaveBeenCalled();
    if (action === "navigate-back") expect(control.input!.sendInFlightRef.current).toBe(true);
  },
);

it.each(["current", "navigate-back", "unmount"] as const)(
  "remote unlock resumes only the original current surface: %s",
  async (mode) => {
    const api = await installSendApi();
    const target = "ssh-target";
    useStore.setState((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === recentId ? { ...thread, workspaceExecutionTargetId: target } : thread,
      ),
    }));
    useRemoteAccessStore.getState().setExecutionTargetCheck(target, {
      status: "auth_required",
      message: "Unlock required",
      tip: null,
      authMode: "password",
      promptLabel: "Password",
    });
    const control = createSendControl();
    mounted = await render(<SendHarness threadId={recentId} control={control} />);
    await control.onSend();
    expect(api.dispatchCommand).not.toHaveBeenCalled();
    const resume = useRemoteAccessStore.getState().pendingAction?.onVerified;
    expect(resume).toBeTypeOf("function");
    if (mode === "navigate-back") {
      await mounted.rerender(<SendHarness threadId={otherId} control={control} />);
      await mounted.rerender(<SendHarness threadId={recentId} control={control} />);
    } else if (mode === "unmount") {
      await mounted.unmount();
      mounted = undefined;
    }
    const lockedOnSend = control.onSend;
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    useRemoteAccessStore.getState().clearAuthDialog();
    if (mode === "current") await vi.waitFor(() => expect(control.onSend).not.toBe(lockedOnSend));
    // Exercise the callback saved by the production auth gate, with network unlock
    // represented by its real verified-store transition, not a live SSH request.
    await resume!();
    expect(api.dispatchCommand).toHaveBeenCalledTimes(mode === "current" ? 1 : 0);
    if (mode !== "current") expect(draft()?.prompt).toBe("Original follow-up");
    expect(draft(otherId)?.prompt).toBe("Other thread draft");
  },
);

it("keeps the busy-thread gate ahead of ordinary turn dispatch", async () => {
  const api = await installSendApi();
  const control = createSendControl();
  mounted = await render(
    <SendHarness threadId={recentId} control={control} overrides={{ isSendBusy: true }} />,
  );
  await control.onSend();
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  expect(draft()?.prompt).toBe("Original follow-up");
  expect(useStore.getState().threads.find((thread) => thread.id === recentId)?.error).toContain(
    "already in progress",
  );
});
