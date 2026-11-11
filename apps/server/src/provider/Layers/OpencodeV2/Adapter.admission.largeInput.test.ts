import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import type { SessionInboxUser } from "@opencode/client";
import { makeNoExecutionAdmissionTransport } from "./Adapter.admission.ts";
import { V2RuntimeHttpFixture } from "./Runtime.fixture.ts";

const row: ProviderTurnAdmission = {
  namespace: "foreground",
  ownerThreadId: ThreadId.makeUnsafe("owner"),
  requestMessageId: MessageId.makeUnsafe("request"),
  nativeAdmissionId: "msg_request",
  turnId: TurnId.makeUnsafe("turn"),
  fingerprint: "fixture",
  state: "accepted",
  revision: 2,
  createdAt: "fixture",
  updatedAt: "fixture",
  finalText: null,
  binding: {
    provider: "opencodeV2",
    threadId: ThreadId.makeUnsafe("owner"),
    nativeSessionId: "ses_fixture",
    location: "/synthetic",
    runtimeTargetId: "local",
    workspaceTargetId: "local",
    storageIdentity: "fixture",
  },
};

it("accepts large correlated acknowledgements while retaining blank and correlation checks", async () => {
  const http = new V2RuntimeHttpFixture();
  const text = `START${"x".repeat(240_000)}END`;
  const ack: SessionInboxUser = {
    id: row.nativeAdmissionId,
    sessionID: row.binding.nativeSessionId,
    type: "user",
    delivery: "queue",
    time: { created: 1 },
    payload: { text },
  };
  const prompt = vi.spyOn(http.client.session, "prompt").mockResolvedValue(ack);
  const inbox = vi.spyOn(http.client.session.inbox, "list").mockResolvedValue([ack]);
  const transport = makeNoExecutionAdmissionTransport(http.client, text);
  expect(await Effect.runPromise(transport.dispatch(row))).toBe(true);
  expect(prompt).toHaveBeenCalledOnce();
  expect(prompt.mock.calls[0]?.[0]).toMatchObject({ text, resume: false, delivery: "queue" });
  expect(await Effect.runPromise(transport.reconcile(row))).toBe("accepted");
  prompt.mockResolvedValueOnce({ ...ack, sessionID: "wrong-session" });
  expect(await Effect.runPromise(transport.dispatch(row))).toBe(false);
  inbox.mockResolvedValueOnce([{ ...ack, payload: { text: "wrong-text" } }]);
  expect(await Effect.runPromise(transport.reconcile(row))).toBe("unknown");
  inbox.mockResolvedValueOnce([]);
  expect(await Effect.runPromise(transport.reconcile(row))).toBe("unknown");
  prompt.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await expect(Effect.runPromise(transport.dispatch(row))).rejects.toMatchObject({
    _tag: "V2AdmissionUnconfirmed",
  });
  const blank = makeNoExecutionAdmissionTransport(http.client, "  ");
  await expect(Effect.runPromise(blank.dispatch(row))).rejects.toMatchObject({
    _tag: "V2AdmissionUnconfirmed",
  });
  await expect(Effect.runPromise(blank.reconcile(row))).rejects.toMatchObject({
    _tag: "V2AdmissionUnconfirmed",
  });
  expect(prompt).toHaveBeenCalledTimes(3);
  expect(inbox).toHaveBeenCalledTimes(3);
});
