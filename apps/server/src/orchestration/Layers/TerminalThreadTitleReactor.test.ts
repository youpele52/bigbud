import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeTerminalTitleListener } from "./TerminalThreadTitleReactor.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { makePrepareCommandState } from "./OrchestrationEngine.prepareCommandState.ts";
import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { TERMINAL_TITLE_COMMAND_PREFIX } from "../../orchestration-tools/TerminalThreadTitle.ts";
import { TERMINAL_AGENTS } from "../../terminal/terminalAgents.ts";

const base = { threadId: "thread", terminalId: "main", createdAt: "2026-10-17T00:00:00.000Z" };
const output = (data: string, terminalId = "main"): TerminalEvent => ({
  ...base,
  terminalId,
  type: "output",
  data,
});
const fixture = () => {
  const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>(() =>
    Effect.succeed({ sequence: 1 }),
  );
  const listener = makeTerminalTitleListener({ dispatch });
  return { dispatch, send: (event: TerminalEvent) => Effect.runPromise(listener(event)) };
};

describe("thread terminal title observation", () => {
  it("uses a fictional agent adapter in the real listener without provider-specific branches", async () => {
    const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>(() =>
      Effect.succeed({ sequence: 1 }),
    );
    const listener = makeTerminalTitleListener({ dispatch }, [
      ...TERMINAL_AGENTS,
      {
        id: "nebula-worker",
        names: ["Nebula CLI"],
        titlePrefixes: ["◇ "],
      },
    ]);
    await Effect.runPromise(listener(output("\x1b]2;Review auth flow\x07", "unknown")));
    expect(dispatch).not.toHaveBeenCalled();
    await Effect.runPromise(listener(output("\x1b]2;Nebula CLI: Working (20s)\x07", "unknown")));
    expect(dispatch).not.toHaveBeenCalled();
    await Effect.runPromise(listener(output("\x1b]2;◇ Review auth flow\x07", "unknown")));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ title: "Review auth flow" }));
  });
  it.each(["main", "default", "side-terminal-2", "split-middle"])(
    "observes any terminal id: %s",
    async (id) => {
      const harness = fixture();
      await harness.send(output("\x1b]2;Gemini CLI: Repair auth flow\x07", id));
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread", title: "Repair auth flow" }),
      );
      await harness.send(output("\x1b]2;Gemini CLI: Another task\x07", id));
      expect(harness.dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps split sequences isolated per terminal", async () => {
    const harness = fixture();
    await harness.send(output("\x1b]2;Claude: Fix ", "left"));
    await harness.send(output("shell output\x07", "right"));
    expect(harness.dispatch).not.toHaveBeenCalled();
    await harness.send(output("reconnect handling\x07", "left"));
    expect(harness.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix reconnect handling" }),
    );
  });

  it("does not name threads from shell output or generic agent identities", async () => {
    const harness = fixture();
    await harness.send(output("\x1b]2;bun dev\x07\x1b]2;Claude\x07\x1b]2;Ready\x07"));
    await harness.send({ ...base, type: "agentIdentity", provider: "claudeAgent" });
    expect(harness.dispatch).not.toHaveBeenCalled();
    await harness.send(output("\x1b]2;Fix reconnect handling\x07"));
    expect(harness.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fix reconnect handling" }),
    );
  });

  it("does not reuse an agent identity after shell activity resumes", async () => {
    const harness = fixture();
    await harness.send({ ...base, type: "agentIdentity", provider: "claudeAgent" });
    await harness.send({ ...base, type: "activity", hasRunningSubprocess: false });
    await harness.send(output("\x1b]2;Ordinary shell title\x07"));
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("never replays snapshot history and resets partial OSC at lifecycle boundaries", async () => {
    const harness = fixture();
    await harness.send(output("\x1b]2;Claude: Old "));
    await harness.send({ ...base, type: "cleared" });
    await harness.send(output("task title\x07"));
    expect(harness.dispatch).not.toHaveBeenCalled();
    await harness.send({
      ...base,
      type: "started",
      snapshot: {
        ...base,
        cwd: "/Some workspace",
        worktreePath: null,
        dropPathMode: "posix",
        status: "running",
        pid: 123,
        activeAgentProvider: "claudeAgent",
        history: "\x1b]2;Claude: Old task title\x07",
        updatedAt: base.createdAt,
        exitCode: null,
        exitSignal: null,
      },
    });
    expect(harness.dispatch).not.toHaveBeenCalled();
    await harness.send(output("\x1b]2;Claude: Some workspace\x07"));
    await harness.send({ ...base, type: "cleared" });
    await harness.send(output("\x1b]2;Claude: Some workspace\x07"));
    expect(harness.dispatch).not.toHaveBeenCalled();
    await harness.send(output("\x1b]2;Fresh task title\x07"));
    expect(harness.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Fresh task title" }),
    );
  });

  it("loads history for the atomic eligibility check even for idle existing threads", async () => {
    const load = vi.fn(() => Effect.sync(() => undefined));
    await Effect.runPromise(
      makePrepareCommandState({ threadStateHydrator: { load } })({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(`${TERMINAL_TITLE_COMMAND_PREFIX}test`),
        threadId: ThreadId.makeUnsafe("thread"),
        title: "Fix terminal lifecycle",
      }),
    );
    expect(load).toHaveBeenCalledWith("thread", "history");
  });
});
