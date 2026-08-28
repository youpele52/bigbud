import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareDraftMaterialization } from "./ChatView.materializationAttempt";
import { digestMaterializationRequest } from "../../../stores/materialization/materializationRequestDigest";
import { MATERIALIZATION_LEDGER_KEY } from "../../../stores/materialization/materializationLedger";

const threadId = ThreadId.makeUnsafe("thread-1");
const projectId = ProjectId.makeUnsafe("project-1");
const commandId = CommandId.makeUnsafe("command-1");
const messageId = MessageId.makeUnsafe("message-1");

describe("prepareDraftMaterialization", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists stable IDs only after authoritative absence is confirmed", async () => {
    const result = await prepareDraftMaterialization({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            status: "absent" as const,
            serverEpoch: "server-1",
            canonicalRevision: 4,
          })),
        } as never,
      },
      threadId,
      projectId,
      commandId,
      messageId,
      kind: "turn",
      createdAt: "2026-08-26T12:00:00.000Z",
      requestDigest: await digestMaterializationRequest({
        text: "hello",
        runtimeMode: "full-access",
      }),
    });

    expect(result).toMatchObject({
      status: "ready",
      attempt: { commandId, messageId, serverEpoch: "server-1", ownershipRevision: 4 },
    });
  });

  it("does not create an attempt while canonical ownership is unavailable", async () => {
    const result = await prepareDraftMaterialization({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            status: "unavailable" as const,
            ownership: "unconfirmed" as const,
            reason: "offline",
          })),
        } as never,
      },
      threadId,
      projectId,
      commandId,
      messageId,
      kind: "turn",
      createdAt: "2026-08-26T12:00:00.000Z",
      requestDigest: await digestMaterializationRequest({
        text: "hello",
        runtimeMode: "full-access",
      }),
    });

    expect(result).toEqual({ status: "blocked", reason: "offline" });
    expect(localStorage.getItem(MATERIALIZATION_LEDGER_KEY)).toBeNull();
  });

  it("retries an unknown attempt with its stable command and message IDs", async () => {
    const api = {
      orchestration: {
        getCommandOutcome: vi.fn(async () => ({
          commandId,
          status: "unknown" as const,
          serverEpoch: "server-1",
          canonicalRevision: 5,
        })),
        resolveThreadOwnership: vi.fn(async () => ({
          threadId,
          status: "absent" as const,
          serverEpoch: "server-1",
          canonicalRevision: 5,
        })),
      },
    } as never;
    const first = await prepareDraftMaterialization({
      api,
      threadId,
      projectId,
      commandId,
      messageId,
      kind: "turn",
      createdAt: "2026-08-26T12:00:00.000Z",
      requestDigest: "sha256:request",
    });
    const retried = await prepareDraftMaterialization({
      api,
      threadId,
      projectId,
      commandId: CommandId.makeUnsafe("command-new"),
      messageId: MessageId.makeUnsafe("message-new"),
      kind: "turn",
      createdAt: "2026-08-26T12:01:00.000Z",
      requestDigest: "sha256:request",
    });

    expect(first).toMatchObject({ status: "ready" });
    expect(retried).toMatchObject({
      status: "ready",
      attempt: { commandId, messageId, generation: 1 },
    });
  });

  it("retries the stable attempt when outcome lookup fails but ownership is available", async () => {
    const api = {
      orchestration: {
        getCommandOutcome: vi.fn(async () => {
          throw new Error("outcome RPC unavailable");
        }),
        resolveThreadOwnership: vi.fn(async () => ({
          threadId,
          projectId,
          status: "active" as const,
          serverEpoch: "server-1",
          canonicalRevision: 5,
        })),
      },
    } as never;
    await prepareDraftMaterialization({
      api,
      threadId,
      projectId,
      commandId,
      messageId,
      kind: "turn",
      createdAt: "2026-08-26T12:00:00.000Z",
      requestDigest: "sha256:request",
      trackExistingThread: true,
    });

    const retried = await prepareDraftMaterialization({
      api,
      threadId,
      projectId,
      commandId: CommandId.makeUnsafe("command-new"),
      messageId: MessageId.makeUnsafe("message-new"),
      kind: "turn",
      createdAt: "2026-08-26T12:01:00.000Z",
      requestDigest: "sha256:request",
      trackExistingThread: true,
    });

    expect(retried).toMatchObject({
      status: "ready",
      attempt: { commandId, messageId, generation: 1 },
    });
  });

  it("persists an outcome-required attempt for an existing thread", async () => {
    const result = await prepareDraftMaterialization({
      api: {
        orchestration: {
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            projectId,
            status: "active" as const,
            serverEpoch: "server-1",
            canonicalRevision: 6,
          })),
        } as never,
      },
      threadId,
      projectId,
      commandId,
      messageId,
      kind: "turn",
      createdAt: "2026-08-26T12:00:00.000Z",
      requestDigest: "sha256:request",
      trackExistingThread: true,
    });

    expect(result).toMatchObject({
      status: "ready",
      attempt: { commandId, requiresOutcome: true, ownershipRevision: 6 },
    });
  });
});
