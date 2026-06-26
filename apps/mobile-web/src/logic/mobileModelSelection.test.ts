import {
  BUILT_IN_CHATS_PROJECT_ID,
  type OrchestrationProject,
  type OrchestrationThread,
  type ServerProvider,
  ThreadId,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { createMobileDraftThread } from "../lib/mobileDraftThread";
import {
  isMobileComposerModelLocked,
  resolveComposerModelLabel,
  resolveMobileComposerModelSelection,
  resolveMobileLockedProvider,
} from "./mobileModelSelection.logic";

const PROJECT_ID = BUILT_IN_CHATS_PROJECT_ID;
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

const baseThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "T",
  modelSelection: { provider: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  deletingAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
} as unknown as OrchestrationThread;

const baseProject = {
  id: PROJECT_ID,
  title: "Demo",
  workspaceRoot: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletingAt: null,
  deletedAt: null,
} as unknown as OrchestrationProject;

describe("isMobileComposerModelLocked", () => {
  it("does not lock before the thread has a turn or session", () => {
    expect(isMobileComposerModelLocked(baseThread, null)).toBe(false);
  });

  it("does not lock drafts", () => {
    const draft = createMobileDraftThread(PROJECT_ID);
    expect(isMobileComposerModelLocked(null, draft)).toBe(false);
  });

  it("does not lock when neither thread nor draft exists", () => {
    expect(isMobileComposerModelLocked(null, null)).toBe(false);
  });

  it("locks once the thread has a turn", () => {
    const started = {
      ...baseThread,
      latestTurn: {
        turnId: ThreadId.makeUnsafe("turn-1") as never,
        state: "completed" as const,
        requestedAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    } as unknown as OrchestrationThread;
    expect(isMobileComposerModelLocked(started, null)).toBe(true);
  });

  it("locks once the thread has a session", () => {
    const started = {
      ...baseThread,
      session: {
        threadId: THREAD_ID,
        status: "idle" as const,
        providerName: null,
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as OrchestrationThread;
    expect(isMobileComposerModelLocked(started, null)).toBe(true);
  });
});

describe("resolveMobileLockedProvider", () => {
  it("returns null for unstarted threads", () => {
    expect(resolveMobileLockedProvider(baseThread, null)).toBeNull();
  });

  it("returns null for drafts", () => {
    const draft = createMobileDraftThread(PROJECT_ID);
    expect(resolveMobileLockedProvider(null, draft)).toBeNull();
  });

  it("returns the thread's model selection provider once started", () => {
    const started = {
      ...baseThread,
      latestTurn: {
        turnId: ThreadId.makeUnsafe("turn-1") as never,
        state: "completed" as const,
        requestedAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    } as unknown as OrchestrationThread;
    expect(resolveMobileLockedProvider(started, null)).toBe("codex");
  });
});

describe("resolveMobileComposerModelSelection", () => {
  it("returns the pending selection when a real thread exists", () => {
    const result = resolveMobileComposerModelSelection(
      {
        thread: baseThread,
        draft: null,
        project: baseProject,
        providers: [],
        isRunning: true,
      },
      { provider: "claudeAgent", model: "opus" },
    );
    expect(result).toEqual({ provider: "claudeAgent", model: "opus" });
  });

  it("falls back to the thread selection when no pending selection exists", () => {
    const result = resolveMobileComposerModelSelection(
      {
        thread: baseThread,
        draft: null,
        project: baseProject,
        providers: [],
        isRunning: true,
      },
      null,
    );
    expect(result).toEqual({ provider: "codex", model: "gpt-5" });
  });

  it("returns the pending selection on a draft when one is set", () => {
    const draft = createMobileDraftThread(PROJECT_ID);
    const result = resolveMobileComposerModelSelection(
      {
        thread: null,
        draft,
        project: baseProject,
        providers: [],
        isRunning: false,
      },
      { provider: "claudeAgent", model: "opus" },
    );
    expect(result).toEqual({ provider: "claudeAgent", model: "opus" });
  });

  it("falls back to the project default on a draft with no pending selection", () => {
    const draft = createMobileDraftThread(PROJECT_ID);
    const result = resolveMobileComposerModelSelection(
      {
        thread: null,
        draft,
        project: {
          ...baseProject,
          defaultModelSelection: { provider: "claudeAgent", model: "default" },
        },
        providers: [],
        isRunning: false,
      },
      null,
    );
    expect(result).toEqual({ provider: "claudeAgent", model: "default" });
  });

  it("falls back to the first ready provider when no selection is available", () => {
    const draft = createMobileDraftThread(PROJECT_ID);
    const providers: ReadonlyArray<ServerProvider> = [
      provider({
        provider: "codex",
        status: "ready",
        models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
      }),
      provider({ provider: "claudeAgent", models: [] }),
    ];
    const result = resolveMobileComposerModelSelection(
      { thread: null, draft, project: baseProject, providers, isRunning: false },
      null,
    );
    expect(result.provider).toBe("codex");
    expect(result.model).toBe("gpt-5");
  });
});

describe("resolveComposerModelLabel", () => {
  const providers: ReadonlyArray<ServerProvider> = [
    provider({
      provider: "codex",
      models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
    }),
  ];

  it("returns the server-provided name when the slug matches", () => {
    expect(resolveComposerModelLabel("codex", "gpt-5", providers)).toBe("GPT-5");
  });

  it("returns the slug itself when no model list is available", () => {
    expect(resolveComposerModelLabel("codex", "gpt-5", [])).toBe("gpt-5");
  });

  it("decodes sub-provider IDs for picker-style values", () => {
    const opencodeProvider = provider({
      provider: "opencode",
      models: [
        {
          slug: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6 (OpenRouter)",
          isCustom: false,
          capabilities: null,
          subProviderID: "openrouter",
        },
      ],
    });
    const result = resolveComposerModelLabel("opencode", "claude-sonnet-4-6::openrouter", [
      opencodeProvider,
    ]);
    expect(result).toBe("Claude Sonnet 4.6 (OpenRouter)");
  });
});
