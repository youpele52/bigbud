import {
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import { truncate } from "@bigbud/shared/String";
import { buildExplicitExecutionTargets } from "~/lib/providerExecutionTargets";
import { generateHandoffDocument, HandoffError, buildHandoffSeedMessage } from "~/lib/handoff";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { isLatestTurnSettled } from "~/logic/session";
import { readNativeApi } from "~/rpc/nativeApi";
import { selectThreadById, useStore } from "~/stores/main";
import { waitForStartedServerThread } from "../view/ChatView.threadWait.logic";
import { resolveOrchestraScoreName } from "./orchestra.naming";

import type { SeedMessageOutput } from "../../../lib/threadBranch";
import type { Project, Thread } from "../../../models/types";

export type OrchestraRunMode = "together" | "sequence";

export interface OrchestraAssignmentDraft {
  readonly id: string;
  readonly modelSelection: ModelSelection;
  readonly prompt: string;
}

export interface RunOrchestraInput {
  readonly assignments: ReadonlyArray<OrchestraAssignmentDraft>;
  readonly mode: OrchestraRunMode;
  readonly scoreName: string;
}

export interface RunOrchestraResult {
  readonly parentThreadId: ThreadId;
  readonly parentThreadTitle: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

interface OrchestraParentThread {
  readonly threadId: ThreadId;
  readonly title: string;
}

interface CreateThreadInput {
  readonly assignment: OrchestraAssignmentDraft;
  readonly index: number;
  readonly parentThread: OrchestraParentThread;
  readonly seedMessages?: ReadonlyArray<SeedMessageOutput>;
}

interface OrchestraOperations {
  readonly createParentThread: (
    input: Pick<RunOrchestraInput, "assignments" | "scoreName">,
  ) => Promise<OrchestraParentThread>;
  readonly createThread: (input: CreateThreadInput) => Promise<ThreadId>;
  readonly createHandoffSeedMessage: (threadId: ThreadId) => Promise<SeedMessageOutput>;
  readonly waitForThreadCompletion: (threadId: ThreadId) => Promise<void>;
}

function buildOrchestraThreadTitle(prompt: string, index: number): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncate(firstLine ?? `Orchestra ${index + 1}`);
}

export async function waitForThreadCompletion(
  threadId: ThreadId,
  timeoutMs = 60 * 60 * 1000,
): Promise<void> {
  const started = await waitForStartedServerThread(threadId, 5_000);
  if (!started) {
    throw new Error("Thread did not start.");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let expectedTurnId: TurnId | null = null;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      callback();
    };

    const check = () => {
      const state = useStore.getState();
      const thread = selectThreadById(threadId)(state);
      if (!thread) {
        finish(() => reject(new Error("Thread disappeared before completion.")));
        return;
      }
      const sessionStatus = thread.session?.orchestrationStatus ?? null;
      if (sessionStatus === "error") {
        finish(() => reject(new Error("Thread session failed before assignment completion.")));
        return;
      }

      const latestTurn = thread.latestTurn;
      if (expectedTurnId === null) {
        if (latestTurn === null || latestTurn.startedAt === null) {
          if (sessionStatus === "stopped") {
            finish(() => reject(new Error("Thread stopped before the assignment turn started.")));
          }
          return;
        }
        expectedTurnId = latestTurn.turnId;
      }

      if (latestTurn === null || latestTurn.turnId !== expectedTurnId) {
        finish(() => reject(new Error("Thread advanced before the assignment turn completed.")));
        return;
      }
      if (latestTurn.state === "error" || latestTurn.state === "interrupted") {
        finish(() => reject(new Error(`Assignment turn ${latestTurn.state}.`)));
        return;
      }
      if (sessionStatus === "stopped" && latestTurn.state !== "completed") {
        finish(() => reject(new Error("Thread stopped before assignment completion.")));
        return;
      }
      if (latestTurn.state === "completed" && isLatestTurnSettled(latestTurn, thread.session)) {
        finish(() => resolve());
      }
    };

    const unsubscribe = useStore.subscribe(check);
    timeoutId = globalThis.setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for thread completion.")));
    }, timeoutMs);
    check();
  });
}

export async function runOrchestra(
  input: RunOrchestraInput,
  operations: OrchestraOperations,
): Promise<RunOrchestraResult> {
  const parentThread = await operations.createParentThread(input);
  const threadIds: ThreadId[] = [];

  if (input.mode === "together") {
    for (const [index, assignment] of input.assignments.entries()) {
      threadIds.push(await operations.createThread({ assignment, index, parentThread }));
    }
    return {
      parentThreadId: parentThread.threadId,
      parentThreadTitle: parentThread.title,
      threadIds,
    };
  }

  let previousThreadId: ThreadId | null = null;
  for (const [index, assignment] of input.assignments.entries()) {
    const seedMessages =
      previousThreadId === null
        ? undefined
        : [await operations.createHandoffSeedMessage(previousThreadId)];
    const nextThreadId = await operations.createThread({
      assignment,
      index,
      parentThread,
      ...(seedMessages ? { seedMessages } : {}),
    });
    threadIds.push(nextThreadId);
    await operations.waitForThreadCompletion(nextThreadId);
    previousThreadId = nextThreadId;
  }

  return {
    parentThreadId: parentThread.threadId,
    parentThreadTitle: parentThread.title,
    threadIds,
  };
}

function buildOrchestraParentThreadTitle(scoreName: string): string {
  return truncate(`Orchestra: ${scoreName}`);
}

function buildOrchestraChildThreadTitle(scoreName: string, prompt: string, index: number): string {
  return truncate(`${scoreName} · ${buildOrchestraThreadTitle(prompt, index)}`);
}

export function createOrchestraOperations(input: {
  readonly activeProject: Project;
  readonly activeThread: Thread | null;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
}): OrchestraOperations {
  const createBaseThreadCommand = (
    threadId: ThreadId,
    title: string,
    modelSelection: ModelSelection,
  ) => {
    const createdAt = new Date().toISOString();
    const executionTargets = buildExplicitExecutionTargets({
      providerRuntimeExecutionTargetId:
        input.activeThread?.providerRuntimeExecutionTargetId ??
        input.activeProject.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId:
        input.activeThread?.workspaceExecutionTargetId ??
        input.activeProject.workspaceExecutionTargetId,
    });

    return {
      createdAt,
      command: {
        type: "thread.create" as const,
        commandId: newCommandId(),
        threadId,
        projectId: input.activeProject.id,
        title,
        ...executionTargets,
        modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default" as const,
        branch: input.activeThread?.branch ?? null,
        worktreePath: input.activeThread?.worktreePath ?? null,
        createdAt,
      },
    };
  };

  return {
    createParentThread: async ({ assignments, scoreName }) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API is not available.");
      }

      const resolvedScoreName = resolveOrchestraScoreName(scoreName);
      const threadId = newThreadId();
      const title = buildOrchestraParentThreadTitle(resolvedScoreName);
      const { command } = createBaseThreadCommand(threadId, title, assignments[0]!.modelSelection);

      await api.orchestration.dispatchCommand(command);

      return { threadId, title: resolvedScoreName };
    },
    createThread: async ({ assignment, index, parentThread, seedMessages }) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API is not available.");
      }

      const threadId = newThreadId();
      const title = buildOrchestraChildThreadTitle(parentThread.title, assignment.prompt, index);
      const { createdAt, command } = createBaseThreadCommand(
        threadId,
        title,
        assignment.modelSelection,
      );

      await api.orchestration.dispatchCommand({
        ...command,
        parentThread,
        ...(seedMessages && seedMessages.length > 0 ? { seedMessages } : {}),
      });

      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: assignment.prompt.trim(),
          attachments: [],
        },
        modelSelection: assignment.modelSelection,
        titleSeed: title,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        createdAt,
      });

      return threadId;
    },
    createHandoffSeedMessage: async (threadId) => {
      const api = readNativeApi();
      if (!api) {
        throw new HandoffError("Native API is not available.");
      }

      const handoffDocument = await generateHandoffDocument({
        threadId,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
      });
      const result = await api.server.writeHandoffDocument({
        title: selectThreadById(threadId)(useStore.getState())?.title ?? "handoff",
        content: handoffDocument,
      });
      return buildHandoffSeedMessage(result.path);
    },
    waitForThreadCompletion,
  };
}
