import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

import {
  PROJECT_ID,
  THREAD_ID,
  asMessageId,
  nowIso,
} from "./orchestrationEngine.integration.shared.ts";

it.live.skipIf(!process.env.CODEX_BINARY_PATH)(
  "keeps the same Codex provider thread across runtime mode switches",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness({ provider: "codex", realCodex: true }),
      (harness) =>
        Effect.gen(function* () {
          const createdAt = nowIso();

          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("cmd-project-create-real-codex"),
            projectId: PROJECT_ID,
            title: "Integration Project",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            createdAt,
          });

          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-thread-create-real-codex"),
            threadId: THREAD_ID,
            projectId: PROJECT_ID,
            title: "Integration Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: harness.workspaceDir,
            createdAt,
          });

          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-start-real-codex-1"),
            threadId: THREAD_ID,
            message: {
              messageId: asMessageId("msg-real-codex-1"),
              role: "user",
              text: "Reply with exactly ALPHA.",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt: nowIso(),
          });

          const firstThread = yield* harness.waitForThread(
            THREAD_ID,
            (entry) =>
              entry.session?.status === "ready" &&
              entry.session.providerName === "codex" &&
              entry.messages.some(
                (message) => message.role === "assistant" && message.streaming === false,
              ),
            180_000,
          );
          assert.equal(firstThread.session?.threadId, "thread-1");

          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-start-real-codex-2"),
            threadId: THREAD_ID,
            message: {
              messageId: asMessageId("msg-real-codex-2"),
              role: "user",
              text: "Reply with exactly BETA.",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: nowIso(),
          });

          const secondThread = yield* harness.waitForThread(
            THREAD_ID,
            (entry) =>
              entry.session?.status === "ready" &&
              entry.session.providerName === "codex" &&
              entry.session.runtimeMode === "approval-required" &&
              entry.messages.some(
                (message) => message.role === "assistant" && message.text.includes("BETA"),
              ),
            180_000,
          );
          assert.equal(secondThread.session?.threadId, "thread-1");
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);
