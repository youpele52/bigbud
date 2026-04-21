import {
  EventId,
  type MessageId,
  type OrchestrationReadModel,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";

import { useComposerDraftStore } from "../../../../stores/composer";
import { NOW_ISO, PROJECT_ID, THREAD_ID, createSnapshotForTargetUser } from "./fixtures";

export function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return { ...snapshot, threads: [] };
}

export function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

export function setDraftThreadWithoutWorktree(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadId: {
      [THREAD_ID]: {
        projectId: PROJECT_ID,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
    projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
  });
}

export function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: new Date(Date.parse(NOW_ISO) + 1_000_000).toISOString(),
                updatedAt: new Date(Date.parse(NOW_ISO) + 1_001_000).toISOString(),
              },
            ],
            updatedAt: new Date(Date.parse(NOW_ISO) + 1_001_000).toISOString(),
          })
        : thread,
    ),
  };
}

export function createSnapshotWithPendingUserInput(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-pending-input-target" as MessageId,
    targetText: "question thread",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: "plan",
            activities: [
              {
                id: EventId.makeUnsafe("activity-user-input-requested"),
                tone: "info",
                kind: "user-input.requested",
                summary: "User input requested",
                payload: {
                  requestId: "req-browser-user-input",
                  questions: [
                    {
                      id: "scope",
                      header: "Scope",
                      question: "What should this change cover?",
                      options: [
                        { label: "Tight", description: "Touch only the footer layout logic." },
                        {
                          label: "Broad",
                          description: "Also adjust the related composer controls.",
                        },
                      ],
                    },
                    {
                      id: "risk",
                      header: "Risk",
                      question: "How aggressive should the imaginary plan be?",
                      options: [
                        {
                          label: "Conservative",
                          description: "Favor reliability and low-risk changes.",
                        },
                        {
                          label: "Balanced",
                          description: "Mix quick wins with one structural improvement.",
                        },
                      ],
                    },
                  ],
                },
                turnId: null,
                sequence: 1,
                createdAt: NOW_ISO,
              },
            ],
            updatedAt: NOW_ISO,
          })
        : thread,
    ),
  };
}

export function createSnapshotWithPlanFollowUpPrompt(options?: {
  modelSelection?: { provider: "codex"; model: string };
  planMarkdown?: string;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-follow-up-target" as MessageId,
    targetText: "plan follow-up thread",
  });
  const baseSession = snapshot.threads.find((thread) => thread.id === THREAD_ID)?.session;
  if (!baseSession) {
    throw new Error("Expected seeded thread session for plan follow-up snapshot.");
  }
  const modelSelection = options?.modelSelection ?? {
    provider: "codex" as const,
    model: "gpt-5",
  };
  const planMarkdown =
    options?.planMarkdown ?? "# Follow-up plan\n\n- Keep the composer footer stable on resize.";

  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, defaultModelSelection: modelSelection } : project,
    ),
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            modelSelection,
            interactionMode: "plan",
            latestTurn: {
              turnId: "turn-plan-follow-up" as TurnId,
              state: "completed",
              requestedAt: NOW_ISO,
              startedAt: NOW_ISO,
              completedAt: NOW_ISO,
              assistantMessageId: null,
            },
            proposedPlans: [
              {
                id: "plan-follow-up-browser-test",
                turnId: "turn-plan-follow-up" as TurnId,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW_ISO,
                updatedAt: NOW_ISO,
              },
            ],
            session: {
              threadId: baseSession.threadId,
              status: "ready",
              providerName: baseSession.providerName,
              runtimeMode: baseSession.runtimeMode,
              activeTurnId: baseSession.activeTurnId,
              lastError: baseSession.lastError,
              updatedAt: NOW_ISO,
            },
            updatedAt: NOW_ISO,
          })
        : thread,
    ),
  };
}

export function buildWorktreeSnapshot(threadId: ThreadId): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-launch-context-target" as MessageId,
    targetText: "launch context worktree override",
  });
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId
        ? Object.assign({}, thread, {
            branch: "feature/branch",
            worktreePath: "/repo/worktrees/feature-branch",
          })
        : thread,
    ),
  };
}
