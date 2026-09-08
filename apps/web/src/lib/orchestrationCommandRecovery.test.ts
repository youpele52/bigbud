import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchCommandWithOutcomeRecovery,
  clearPersistedCommandsForCanonicalEvents,
  OrchestrationCommandOutcomeError,
  reconcilePersistedCommands,
  readPendingCommands,
} from "./orchestrationCommandRecovery";
import {
  ORCHESTRATION_COMMAND_LEDGER_KEY,
  ORCHESTRATION_COMMAND_LEDGER_LEGACY_KEY,
} from "./orchestrationCommandRecovery.storage";

const command = {
  type: "thread.archive" as const,
  commandId: CommandId.makeUnsafe("command-recovery-test"),
  threadId: ThreadId.makeUnsafe("thread-recovery-test"),
};

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

function makeApi(outcome: Parameters<typeof vi.fn>[0] = undefined) {
  return {
    orchestration: {
      dispatchCommand: vi.fn(async () => {
        throw new Error("response lost");
      }),
      getCommandOutcome: vi.fn(outcome),
    },
  } as unknown as Parameters<typeof dispatchCommandWithOutcomeRecovery>[0];
}

describe("dispatchCommandWithOutcomeRecovery", () => {
  it("returns the stored accepted sequence after a lost response", async () => {
    const api = makeApi(async () => ({
      commandId: command.commandId,
      status: "accepted" as const,
      aggregateKind: "thread" as const,
      aggregateId: command.threadId,
      acceptedAt: "2026-08-27T00:00:00.000Z",
      resultSequence: 42,
      serverEpoch: "epoch",
      canonicalRevision: 1,
    }));

    await expect(dispatchCommandWithOutcomeRecovery(api, command)).resolves.toEqual({
      sequence: 42,
    });
    expect(api.orchestration.getCommandOutcome).toHaveBeenCalledWith({
      commandId: command.commandId,
    });
  });

  it("exposes rejected and unknown outcomes without retrying with a new ID", async () => {
    const rejectedApi = makeApi(async () => ({
      commandId: command.commandId,
      status: "rejected" as const,
      aggregateKind: "thread" as const,
      aggregateId: command.threadId,
      rejectedAt: "2026-08-27T00:00:00.000Z",
      resultSequence: 42,
      reason: "other" as const,
      serverEpoch: "epoch",
      canonicalRevision: 1,
    }));
    await expect(dispatchCommandWithOutcomeRecovery(rejectedApi, command)).rejects.toMatchObject({
      status: "rejected",
    });
    expect(rejectedApi.orchestration.dispatchCommand).toHaveBeenCalledWith(command);

    const unknownApi = makeApi(async () => ({
      commandId: command.commandId,
      status: "unknown" as const,
      serverEpoch: "epoch",
      canonicalRevision: 1,
    }));
    await expect(dispatchCommandWithOutcomeRecovery(unknownApi, command)).rejects.toBeInstanceOf(
      OrchestrationCommandOutcomeError,
    );
  });

  it("retains an unknown command for reload reconciliation", async () => {
    const api = makeApi(async () => ({
      commandId: command.commandId,
      status: "unknown" as const,
      serverEpoch: "epoch",
      canonicalRevision: 1,
    }));
    await expect(dispatchCommandWithOutcomeRecovery(api, command)).rejects.toMatchObject({
      status: "unknown",
    });
    await expect(dispatchCommandWithOutcomeRecovery(api, command)).rejects.toMatchObject({
      status: "unknown",
    });
    expect(api.orchestration.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(readPendingCommands()).toHaveLength(1);
  });

  it("persists project create, edit, and delete attempts until canonical replay", async () => {
    const projectId = ProjectId.makeUnsafe("project-crud");
    const commands = [
      {
        type: "project.create" as const,
        commandId: CommandId.makeUnsafe("project-create"),
        projectId,
        title: "Project",
        workspaceRoot: null,
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      {
        type: "project.meta.update" as const,
        commandId: CommandId.makeUnsafe("project-edit"),
        projectId,
        title: "Renamed project",
      },
      {
        type: "project.delete" as const,
        commandId: CommandId.makeUnsafe("project-delete"),
        projectId,
      },
    ];
    const api = {
      orchestration: {
        dispatchCommand: vi.fn(async () => ({ sequence: 1 })),
        getCommandOutcome: vi.fn(),
      },
    } as unknown as Parameters<typeof dispatchCommandWithOutcomeRecovery>[0];

    for (const command of commands) {
      await dispatchCommandWithOutcomeRecovery(api, command);
    }

    expect(readPendingCommands().map((entry) => entry.commandId)).toEqual([
      "project-create",
      "project-edit",
      "project-delete",
    ]);
    const cleared = await clearPersistedCommandsForCanonicalEvents(
      commands.map((command) => ({
        sequence: 1,
        eventId: EventId.makeUnsafe(`event-${command.commandId}`),
        aggregateKind: "project" as const,
        aggregateId: projectId,
        occurredAt: "2026-08-27T00:00:00.000Z",
        commandId: command.commandId,
        causationEventId: null,
        correlationId: command.commandId,
        metadata: {},
        type: "project.meta-updated" as const,
        payload: { projectId, updatedAt: "2026-08-27T00:00:00.000Z" },
      })) as never,
    );

    expect(cleared).toBe(3);
    expect(readPendingCommands()).toHaveLength(0);
  });

  it("queries an unknown persisted command after reload without redispatching payload", async () => {
    const firstApi = makeApi(async () => ({
      commandId: command.commandId,
      status: "unknown" as const,
      serverEpoch: "epoch",
      canonicalRevision: 1,
    }));
    await expect(dispatchCommandWithOutcomeRecovery(firstApi, command)).rejects.toMatchObject({
      status: "unknown",
    });

    const retryApi = {
      orchestration: {
        getCommandOutcome: vi.fn(async () => ({
          commandId: command.commandId,
          status: "unknown" as const,
          serverEpoch: "epoch",
          canonicalRevision: 1,
        })),
        dispatchCommand: vi.fn(async () => ({ sequence: 9 })),
      },
    } as unknown as Parameters<typeof reconcilePersistedCommands>[0];

    await expect(reconcilePersistedCommands(retryApi)).resolves.toMatchObject({
      pending: 1,
      retried: 0,
    });
    expect(retryApi.orchestration.dispatchCommand).not.toHaveBeenCalled();
    expect(readPendingCommands()[0]).toMatchObject({
      commandId: command.commandId,
      status: "pending",
    });
  });

  it("never persists prompt, shell, attachment, or user-input payloads", async () => {
    const sensitiveCommands = [
      {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("sensitive-turn"),
        threadId: command.threadId,
        message: {
          messageId: "message-turn",
          role: "user",
          text: "secret prompt token",
          attachments: [{ type: "text", text: "private attachment" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      {
        type: "thread.shell.run",
        commandId: CommandId.makeUnsafe("sensitive-shell"),
        threadId: command.threadId,
        message: { messageId: "message-shell", role: "user", text: "run secret", attachments: [] },
        shellCommand: "printenv PRIVATE_TOKEN",
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      {
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("sensitive-input"),
        threadId: command.threadId,
        requestId: "request-sensitive",
        answers: { password: "private answer" },
        createdAt: "2026-08-27T00:00:00.000Z",
      },
    ];
    const api = {
      orchestration: {
        dispatchCommand: vi.fn(async () => ({ sequence: 4 })),
        getCommandOutcome: vi.fn(),
      },
    } as unknown as Parameters<typeof dispatchCommandWithOutcomeRecovery>[0];

    for (const sensitiveCommand of sensitiveCommands) {
      await dispatchCommandWithOutcomeRecovery(api, sensitiveCommand as never);
    }

    const raw = storage.get(ORCHESTRATION_COMMAND_LEDGER_KEY) ?? "";
    expect(raw).toContain("sensitive-turn");
    expect(raw).toContain("sensitive-shell");
    expect(raw).toContain("sensitive-input");
    expect(raw).not.toContain("secret prompt token");
    expect(raw).not.toContain("private attachment");
    expect(raw).not.toContain("attachments");
    expect(raw).not.toContain("printenv PRIVATE_TOKEN");
    expect(raw).not.toContain("private answer");
  });

  it("removes legacy plaintext, corrupt, and expired recovery records", () => {
    storage.set(ORCHESTRATION_COMMAND_LEDGER_LEGACY_KEY, JSON.stringify({ command }));
    storage.set(ORCHESTRATION_COMMAND_LEDGER_KEY, "not-json");
    expect(readPendingCommands()).toEqual([]);
    expect(storage.has(ORCHESTRATION_COMMAND_LEDGER_LEGACY_KEY)).toBe(false);
    expect(storage.has(ORCHESTRATION_COMMAND_LEDGER_KEY)).toBe(false);

    storage.set(
      ORCHESTRATION_COMMAND_LEDGER_KEY,
      JSON.stringify({
        version: 2,
        revision: 1,
        lastMutationId: "expired",
        attemptsByCommandId: {
          expired: {
            commandId: "expired",
            commandType: "thread.archive",
            savedAt: "2020-01-01T00:00:00.000Z",
            dispatchStartedAt: null,
            status: "pending",
            acceptedSequence: null,
          },
        },
      }),
    );
    expect(readPendingCommands()).toEqual([]);
    expect(
      JSON.parse(storage.get(ORCHESTRATION_COMMAND_LEDGER_KEY) ?? "{}").attemptsByCommandId,
    ).toEqual({});
  });

  it("sanitizes unexpected v2 payload fields and future-dated records", () => {
    storage.set(
      ORCHESTRATION_COMMAND_LEDGER_KEY,
      JSON.stringify({
        version: 2,
        revision: 1,
        lastMutationId: "polluted",
        unexpectedRootPayload: "root secret",
        attemptsByCommandId: {
          current: {
            commandId: "current",
            commandType: "thread.archive",
            command: { text: "persisted secret" },
            savedAt: new Date().toISOString(),
            dispatchStartedAt: null,
            status: "pending",
            acceptedSequence: null,
          },
          future: {
            commandId: "future",
            commandType: "thread.archive",
            text: "future secret",
            savedAt: "2999-01-01T00:00:00.000Z",
            dispatchStartedAt: null,
            status: "pending",
            acceptedSequence: null,
          },
        },
      }),
    );

    expect(readPendingCommands().map((attempt) => attempt.commandId)).toEqual(["current"]);
    const raw = storage.get(ORCHESTRATION_COMMAND_LEDGER_KEY) ?? "";
    expect(raw).not.toContain("root secret");
    expect(raw).not.toContain("persisted secret");
    expect(raw).not.toContain("future secret");
    expect(raw).not.toContain('"future"');
  });
});
