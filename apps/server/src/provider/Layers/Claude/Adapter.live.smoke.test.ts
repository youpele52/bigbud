import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect, Layer, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { makeClaudeAdapterLive } from "./Adapter.ts";
import {
  liveSmokeOptions,
  makeLiveSmokeQuery,
  makeLiveSmokeWorkspace,
  writeLiveSmokeReport,
} from "./Adapter.sdk.smoke.helpers.ts";

const liveTest = process.env.BIGBUD_CLAUDE_ADAPTER_SMOKE === "1" ? it : it.skip;

describe("Claude adapter real transport smoke", () => {
  liveTest(
    "streams same-query turns, resumes native history and interrupts without retaining sessions",
    async () => {
      const workspace = await makeLiveSmokeWorkspace();
      const queries: Query[] = [];
      const nativeResumeOptions: Array<string | undefined> = [];
      const marker = `MARKER_${randomUUID().replaceAll("-", "")}`;
      const threadId = ThreadId.makeUnsafe(`live-smoke-${randomUUID()}`);
      const abortController = new AbortController();
      const deadline = setTimeout(() => abortController.abort(), 50_000);
      try {
        const catalog = await makeLiveSmokeQuery(workspace.cwd, { abortController });
        const model = catalog.model;
        catalog.close();
        const safety = liveSmokeOptions(workspace.cwd);
        const adapterLayer = makeClaudeAdapterLive({
          harness: {
            binaryPath: safety.pathToClaudeCodeExecutable ?? "claude",
            settingSources: [],
            ...(safety.env ? { environment: safety.env } : {}),
          },
          createQuery: (input) => {
            nativeResumeOptions.push(input.options.resume);
            // Real SDK transport and real generated orchestration MCP bridge. Only
            // safety/cost limits are overlaid; retain bigbud's production system prompt.
            const runtime = query({
              prompt: input.prompt,
              options: {
                ...input.options,
                settings: { disableAllHooks: true },
                tools: [],
                allowedTools: [],
                maxTurns: 1,
                maxBudgetUsd: 0.075,
                ...(safety.canUseTool ? { canUseTool: safety.canUseTool } : {}),
                abortController,
              },
            });
            queries.push(runtime);
            return runtime;
          },
        }).pipe(
          Layer.provideMerge(ServerConfig.layerTest(workspace.cwd, workspace.cwd)),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(NodeServices.layer),
        );
        const events: ProviderRuntimeEvent[] = [];
        await Effect.runPromise(
          Effect.gen(function* () {
            const adapter = yield* ClaudeAdapter;
            const collectTurn = () =>
              adapter.streamEvents.pipe(
                Stream.tap((event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
                ),
                Stream.filter((event) => event.type === "turn.completed"),
                Stream.runHead,
              );
            const send = (input: string) => adapter.sendTurn({ threadId, input, attachments: [] });
            const readySession = Effect.fn("liveSmokeReadySession")(function* () {
              for (let attempt = 0; attempt < 100; attempt++) {
                const session = (yield* adapter.listSessions()).find(
                  (row) => row.threadId === threadId,
                );
                if (session?.status === "ready" && !session.activeTurnId) return session;
                yield* Effect.yieldNow;
              }
              return yield* Effect.die("Live adapter did not settle its turn to ready");
            });
            yield* adapter.startSession({
              threadId,
              provider: "claudeAgent",
              cwd: workspace.cwd,
              runtimeMode: "approval-required",
              modelSelection: { provider: "claudeAgent", model },
            });
            yield* send(
              `Remember this harmless marker: ${marker}. Reply only with that marker. Never use tools or modify files.`,
            );
            const first = yield* collectTurn();
            expect(first._tag === "Some" && first.value.payload.state).toBe("completed");
            expect(
              events
                .filter((event) => event.type === "content.delta")
                .map((event) => event.payload.delta)
                .join("")
                .trim(),
            ).toBe(marker);
            const original = yield* readySession();
            const nativeId = (original.resumeCursor as { resume?: string }).resume;
            expect(typeof nativeId === "string").toBe(true);
            let from = events.length;
            yield* send(
              "What was the harmless marker? Reply only with the marker; never use tools.",
            );
            const second = yield* collectTurn();
            expect(second._tag === "Some" && second.value.payload.state).toBe("completed");
            expect(
              events
                .slice(from)
                .filter((event) => event.type === "content.delta")
                .map((event) => event.payload.delta)
                .join("")
                .trim(),
            ).toBe(marker);
            const prior = yield* readySession();
            expect(queries.length).toBe(1);
            yield* adapter.stopSession(threadId);
            expect(yield* adapter.hasSession(threadId)).toBe(false);
            yield* adapter.startSession({
              threadId,
              provider: "claudeAgent",
              cwd: workspace.cwd,
              runtimeMode: "approval-required",
              modelSelection: { provider: "claudeAgent", model },
              resumeCursor: prior.resumeCursor,
            });
            expect(queries.length).toBe(2);
            expect(nativeResumeOptions[1] === nativeId).toBe(true);
            from = events.length;
            yield* send(
              "What was the harmless marker in our earlier conversation? Reply only with the marker; never use tools.",
            );
            const restored = yield* collectTurn();
            expect(restored._tag === "Some" && restored.value.payload.state).toBe("completed");
            expect(
              events
                .slice(from)
                .filter((event) => event.type === "content.delta")
                .map((event) => event.payload.delta)
                .join("")
                .trim(),
            ).toBe(marker);
            yield* readySession();
            yield* send(
              "Print integers from 1 through 300 separated by spaces. Start immediately. Never use tools.",
            );
            let interrupted = false;
            const terminal = yield* adapter.streamEvents.pipe(
              Stream.tap((event) =>
                Effect.gen(function* () {
                  events.push(event);
                  if (
                    !interrupted &&
                    event.type === "content.delta" &&
                    event.payload.delta.length > 0
                  ) {
                    interrupted = true;
                    yield* adapter.interruptTurn(threadId);
                  }
                }),
              ),
              Stream.filter((event) => event.type === "turn.completed"),
              Stream.runHead,
            );
            expect(interrupted).toBe(true);
            expect(terminal._tag === "Some" && terminal.value.payload.state).toBe("interrupted");
            yield* adapter.stopAll();
            expect(yield* adapter.listSessions()).toEqual([]);
            expect(
              events.some(
                (event) => event.type === "request.opened" || event.type === "user-input.requested",
              ),
            ).toBe(false);
          }).pipe(Effect.provide(adapterLayer), Effect.scoped, Effect.timeout("50 seconds")),
        );
        const costs = events.flatMap((event) =>
          event.type === "turn.completed" && event.payload.totalCostUsd !== undefined
            ? [event.payload.totalCostUsd]
            : [],
        );
        expect(costs.length).toBe(4);
        expect(Math.max(...costs)).toBeLessThanOrEqual(0.15);
        await writeLiveSmokeReport("claude-real-adapter", {
          model,
          turns: 4,
          streaming: true,
          sameQueryMemory: true,
          freshQueryResumeMemory: true,
          nativeResumeIdPreserved: true,
          activeInterrupt: true,
          sessionsRemaining: 0,
          interactiveRequests: 0,
          realOrchestrationBridge: true,
          canonicalEventCount: events.length,
          cumulativeEstimatedUsd: costs.at(-1),
          firstQueryEstimatedUsd: costs[1],
          conservativeSumEstimatedUsd: Math.max(...costs.slice(0, 2)) + Math.max(...costs.slice(2)),
        });
      } finally {
        clearTimeout(deadline);
        for (const runtime of queries) runtime.close();
        await workspace.cleanup();
      }
    },
    60_000,
  );
});
