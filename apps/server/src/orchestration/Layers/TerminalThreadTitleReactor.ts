import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import { Effect } from "effect";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import {
  createTerminalTitleReader,
  createTerminalTaskTitleResolver,
} from "../../terminal/terminalTaskTitle.ts";
import {
  TERMINAL_AGENTS,
  terminalAgentForProvider,
  type TerminalAgentDescriptor,
} from "../../terminal/terminalAgents.ts";
import type { TerminalAgentIdentity } from "@bigbud/contracts/workspace/terminal.agentIdentity.ts";
import { TERMINAL_TITLE_COMMAND_PREFIX } from "../../orchestration-tools/TerminalThreadTitle.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

/** Observe live events only: neither restored scrollback nor terminal input is task evidence. */
export function makeTerminalTitleListener(
  engine: Pick<OrchestrationEngineShape, "dispatch">,
  agents: ReadonlyArray<TerminalAgentDescriptor> = TERMINAL_AGENTS,
) {
  const resolveTitle = createTerminalTaskTitleResolver(agents);
  const terminals = new Map<
    string,
    {
      read: ReturnType<typeof createTerminalTitleReader>;
      foregroundAgent: TerminalAgentIdentity | null;
      directories: ReadonlyArray<string>;
      finished: boolean;
    }
  >();
  return (event: TerminalEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const key = JSON.stringify([event.threadId, event.terminalId]);
      if (event.type === "exited" || event.type === "error") {
        terminals.delete(key);
        return;
      }
      if (event.type === "cleared") {
        const state = terminals.get(key);
        if (state) {
          state.read = createTerminalTitleReader();
          state.finished = false;
        }
        return;
      }
      if (event.type === "started" || event.type === "restarted") {
        terminals.delete(key);
      }
      let state = terminals.get(key);
      if (!state) {
        // Closed/evicted terminals need not emit exit; bound observer custody independently.
        if (terminals.size >= 512) terminals.delete(terminals.keys().next().value!);
        state = {
          read: createTerminalTitleReader(),
          foregroundAgent: null,
          directories: [],
          finished: false,
        };
        terminals.set(key, state);
      }
      if (event.type === "started" || event.type === "restarted") {
        state.foregroundAgent =
          event.snapshot.activeAgent !== undefined
            ? event.snapshot.activeAgent
            : event.snapshot.activeAgentProvider
              ? terminalAgentForProvider(event.snapshot.activeAgentProvider, agents)
              : null;
        state.directories = [
          event.snapshot.cwd,
          ...(event.snapshot.worktreePath ? [event.snapshot.worktreePath] : []),
        ];
      } else if (event.type === "agentIdentity") {
        state.foregroundAgent =
          event.agent !== undefined
            ? event.agent
            : event.provider
              ? terminalAgentForProvider(event.provider, agents)
              : null;
      } else if (event.type === "activity" && !event.hasRunningSubprocess) {
        state.foregroundAgent = null;
      } else if (event.type === "output" && !state.finished) {
        for (const raw of state.read(event.data)) {
          const title = resolveTitle(raw, {
            foregroundAgent: state.foregroundAgent,
            directories: state.directories,
          });
          if (!title) continue;
          yield* engine
            .dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe(
                `${TERMINAL_TITLE_COMMAND_PREFIX}${crypto.randomUUID()}`,
              ),
              threadId: ThreadId.makeUnsafe(event.threadId),
              title,
            })
            .pipe(Effect.asVoid);
          state.finished = true;
          return;
        }
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("terminal task naming failed", { cause })),
    );
}

export const makeTerminalThreadTitleStart = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const terminal: TerminalManagerShape = yield* TerminalManager;
  return () =>
    Effect.acquireRelease(terminal.subscribe(makeTerminalTitleListener(engine)), (unsubscribe) =>
      Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid);
});
