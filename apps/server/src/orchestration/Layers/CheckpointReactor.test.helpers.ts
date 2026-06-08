import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { ProviderKind, ProviderRuntimeEvent, ProviderSession } from "@bigbud/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, vi } from "vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../startup/config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────────

export const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
export const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

export type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

export function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = "codex",
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.makeUnsafe("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    startSessionFresh: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}

export async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

export async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

export function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

export function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

export function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

export async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

// ── Cleanup & Harness ────────────────────────────────────────────────────────────

const cleanupTempDirs: string[] = [];
let cleanupRuntime: ManagedRuntime.ManagedRuntime<
  OrchestrationEngineService | CheckpointReactor | CheckpointStore,
  unknown
> | null = null;
let cleanupScope: Scope.Closeable | null = null;

export function trackTempDir(dir: string): void {
  cleanupTempDirs.push(dir);
}

export function registerCheckpointReactorTestCleanup(): void {
  afterEach(async () => {
    if (cleanupScope) {
      await Effect.runPromise(Scope.close(cleanupScope, Exit.void));
    }
    cleanupScope = null;
    if (cleanupRuntime) {
      await cleanupRuntime.dispose();
    }
    cleanupRuntime = null;
    while (cleanupTempDirs.length > 0) {
      const dir = cleanupTempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

export async function createHarness(options?: {
  readonly hasSession?: boolean;
  readonly seedFilesystemCheckpoints?: boolean;
  readonly projectWorkspaceRoot?: string;
  readonly threadWorktreePath?: string | null;
  readonly providerSessionCwd?: string;
  readonly providerName?: ProviderKind;
  readonly gitStatusRefreshCalls?: Array<string>;
}) {
  const cwd = createGitRepository();
  cleanupTempDirs.push(cwd);
  const provider = createProviderServiceHarness(
    cwd,
    options?.hasSession ?? true,
    options?.providerSessionCwd ?? cwd,
    options?.providerName ?? "codex",
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
  );

  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-checkpoint-reactor-test-",
  });
  const gitStatusBroadcasterLayer = Layer.succeed(GitStatusBroadcaster, {
    subscribe: () => Effect.die("subscribe should not be called in this test"),
    refreshLocalStatus: (cwd: string) =>
      Effect.sync(() => {
        options?.gitStatusRefreshCalls?.push(cwd);
      }).pipe(
        Effect.as({
          isRepo: true,
          hasOriginRemote: false,
          isDefaultBranch: true,
          branch: "main",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
      ),
    invalidateLocal: () => Effect.void,
    invalidateRemote: () => Effect.void,
  });

  const layer = CheckpointReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(RuntimeReceiptBusLive),
    Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
    Layer.provideMerge(gitStatusBroadcasterLayer),
    Layer.provideMerge(CheckpointStoreLive),
    Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  cleanupRuntime = ManagedRuntime.make(layer);
  const runtime = cleanupRuntime;
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
  const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
  cleanupScope = await Effect.runPromise(Scope.make("sequential"));
  const scope = cleanupScope;
  await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
  const drain = () => Effect.runPromise(reactor.drain);

  const createdAt = new Date().toISOString();
  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      projectId: asProjectId("project-1"),
      title: "Test Project",
      workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId: asProjectId("project-1"),
      title: "Thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: options?.threadWorktreePath ?? cwd,
      createdAt,
    }),
  );

  if (options?.seedFilesystemCheckpoints ?? true) {
    await runtime.runPromise(
      checkpointStore.captureCheckpoint({
        cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
      }),
    );
    fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
    await runtime.runPromise(
      checkpointStore.captureCheckpoint({
        cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
      }),
    );
    fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
    await runtime.runPromise(
      checkpointStore.captureCheckpoint({
        cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
      }),
    );
  }

  return {
    engine,
    provider,
    cwd,
    drain,
  };
}
