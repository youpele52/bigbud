/**
 * Opt-in live qualification probe against the installed `muse` CLI and the
 * real SDK host (no fakes). Skipped unless MUSE_LIVE_PROBE=1: it spawns
 * `muse serve`, needs the user's native browser sign-in, sends short turns on
 * the non-contributor `muse-spark-1.3`/`muse-wonder-1.0` models in a
 * disposable temp workspace, and leaves one durable native session behind.
 *
 *   MUSE_LIVE_PROBE=1 bun run --cwd apps/server vitest run src/provider/Layers/Muse/Adapter.live.test.ts
 *
 * Scenarios: non-canonical cwd start, plain turn, in-session model switch,
 * shell approval round-trip, user-input question round-trip, Stop on a
 * running turn, Stop on a queued turn, restart + exact-session resume, and a
 * cursorless restart of a bound session (the in-app payload-conflict bug).
 * Use it to produce the Windows/Linux qualification records.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import type {
  MuseSessionBinding,
  MuseSessionBindingsShape,
} from "../../../persistence/Services/MuseSessionBindings.ts";
import { makeMuseAdapterShape } from "./Adapter.ts";
import { makeSdkMuseHostFactory } from "./Client.lifecycle.ts";

type Ev = ProviderRuntimeEvent & {
  requestId?: string;
  turnId?: string;
  payload: Record<string, any>;
};
const events: Ev[] = [];
const transcript: string[] = [];
const threadId = ThreadId.makeUnsafe("muse-live-probe-thread");
// A trailing dot segment below exercises canonicalization on every platform.
const live = process.env.MUSE_LIVE_PROBE === "1";
const rawWorkspace = live
  ? mkdtempSync(join(tmpdir(), "muse-live-probe-"))
  : join(tmpdir(), "muse-live-probe-skipped");
if (live) writeFileSync(join(rawWorkspace, "README.md"), "probe workspace\n");

/** In-memory stand-in for the durable binding table (same reserved → bound rules). */
let bindingRow: MuseSessionBinding | undefined;
const bindings: MuseSessionBindingsShape = {
  find: () => Effect.succeed(bindingRow),
  reserve: (input) =>
    Effect.sync(() => (bindingRow ??= { ...input, phase: "reserved", revision: 0 })),
  transition: (current, phase) =>
    current.phase === "reserved"
      ? Effect.sync(() => (bindingRow = { ...current, phase, revision: current.revision + 1 }))
      : Effect.die(new Error(`binding cannot move from ${current.phase}`)),
};
const deps = {
  hostFactory: makeSdkMuseHostFactory(),
  bindings,
  getSettings: Effect.succeed({ enabled: true, binaryPath: "muse" }),
  platformQualified: true,
};
const baseSelection = { provider: "muse" as const, model: "muse-spark-1.3", subProviderID: "meta" };
const startInput = {
  threadId,
  cwd: `${rawWorkspace}${sep}.`,
  runtimeMode: "auto-accept-edits" as const,
  modelSelection: baseSelection,
};

let adapter: Awaited<ReturnType<typeof makeAdapter>>;
let lastCursor: unknown;
let firstTurnId: string;

async function makeAdapter() {
  const shape = await Effect.runPromise(makeMuseAdapterShape(deps));
  Effect.runFork(
    Stream.runForEach(shape.streamEvents, (event) =>
      Effect.sync(() => {
        const e = event as Ev;
        events.push(e);
        const detail =
          typeof e.payload?.detail === "string" ? ` "${e.payload.detail.slice(0, 80)}"` : "";
        const state = e.payload?.state ? ` state=${e.payload.state}` : "";
        const rt = e.payload?.requestType ? ` ${e.payload.requestType}` : "";
        transcript.push(`${e.type}${rt}${state} turn=${e.turnId?.slice(0, 8) ?? "-"}${detail}`);
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 20));
  return shape;
}

function waitFor(pred: (e: Ev) => boolean, timeoutMs: number, label: string): Promise<Ev> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = events.find(pred);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs)
        return reject(new Error(`timeout: ${label}\n${transcript.slice(-25).join("\n")}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}
const assistantText = (turnId: string) =>
  events
    .filter(
      (e) =>
        e.type === "item.completed" &&
        e.turnId === turnId &&
        e.payload?.itemType === "assistant_message",
    )
    .map((e) => String(e.payload.detail ?? ""))
    .join("\n");
const completion = (turnId: string, ms = 120_000) =>
  waitFor(
    (e) => e.type === "turn.completed" && e.turnId === turnId,
    ms,
    `turn.completed ${turnId}`,
  );

describe.skipIf(process.env.MUSE_LIVE_PROBE !== "1")("Muse live probe (real CLI)", () => {
  afterAll(async () => {
    if (!live) return;
    await Effect.runPromise(adapter.stopAll()).catch(() => undefined);
    rmSync(rawWorkspace, { recursive: true, force: true });
    console.log("\n=== TRANSCRIPT ===\n" + transcript.join("\n"));
  });

  it("A: starts a session from a non-canonical cwd", async () => {
    adapter = await makeAdapter();
    const session = await Effect.runPromise(adapter.startSession(startInput));
    expect(session.cwd).toBe(realpathSync(rawWorkspace));
    expect(session.model).toBe("muse-spark-1.3");
    lastCursor = session.resumeCursor;
    await waitFor((e) => e.type === "session.started", 5_000, "session.started");
  }, 60_000);

  it("B: plain turn streams and completes", async () => {
    const turn = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "Reply with exactly the single word PONG and nothing else.",
      }),
    );
    firstTurnId = turn.turnId;
    lastCursor = turn.resumeCursor;
    const done = await completion(turn.turnId);
    expect(done.payload.state).toBe("completed");
    expect(assistantText(turn.turnId)).toMatch(/PONG/);
    expect(events.some((e) => e.type === "turn.started" && e.turnId === turn.turnId)).toBe(true);
  }, 150_000);

  it("C: in-session model switch to muse-wonder-1.0 and back", async () => {
    const t1 = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "Reply with exactly the single word PING and nothing else.",
        modelSelection: { ...baseSelection, model: "muse-wonder-1.0" },
      }),
    );
    expect((t1.resumeCursor as { model: string }).model).toBe("muse-wonder-1.0");
    expect((await completion(t1.turnId)).payload.state).toBe("completed");
    expect(assistantText(t1.turnId)).toMatch(/PING/);
    const t2 = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "Reply with exactly the single word BACK.",
        modelSelection: baseSelection,
      }),
    );
    expect((t2.resumeCursor as { model: string }).model).toBe("muse-spark-1.3");
    expect((await completion(t2.turnId)).payload.state).toBe("completed");
    lastCursor = t2.resumeCursor;
  }, 240_000);

  it("D: shell command needs a native approval, accept routes through approval/decide", async () => {
    const turn = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input:
          "Run exactly this shell command: echo approval-probe-ok\nThen reply with only the command's output.",
      }),
    );
    const req = await Promise.race([
      waitFor(
        (e) => e.type === "request.opened" && e.turnId === turn.turnId,
        120_000,
        "request.opened",
      ),
      completion(turn.turnId).then(() => undefined),
    ]);
    if (req) {
      expect(req.payload.requestType).toBe("command_execution_approval");
      expect(req.payload.detail).toContain("echo approval-probe-ok");
      await Effect.runPromise(adapter.respondToRequest(threadId, req.requestId as never, "accept"));
      transcript.push(`>> accepted approval ${req.requestId}`);
    } else {
      transcript.push(
        ">> NO approval was requested for the shell command (native policy allowed it)",
      );
    }
    const done = await completion(turn.turnId);
    expect(done.payload.state).toBe("completed");
    expect(assistantText(turn.turnId)).toContain("approval-probe-ok");
    expect(req).toBeDefined();
  }, 200_000);

  it("E: user-input question round-trips through respondToUserInput", async () => {
    const turn = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input:
          "Use your ask-the-user question tool to ask me a single-choice question 'Tabs or Spaces?' with exactly the two options Tabs and Spaces. After I answer, reply with exactly the option I chose and nothing else.",
      }),
    );
    const req = await Promise.race([
      waitFor(
        (e) => e.type === "user-input.requested" && e.turnId === turn.turnId,
        120_000,
        "user-input.requested",
      ),
      completion(turn.turnId).then(() => undefined),
    ]);
    if (req) {
      const q = req.payload.questions[0];
      const label =
        q.options.find((o: { label: string }) => /spaces/i.test(o.label))?.label ??
        q.options[0].label;
      await Effect.runPromise(
        adapter.respondToUserInput(threadId, req.requestId as never, { [q.id]: label }),
      );
      transcript.push(`>> answered question ${q.id} with ${label}`);
      const done = await completion(turn.turnId);
      expect(done.payload.state).toBe("completed");
      expect(assistantText(turn.turnId)).toMatch(/spaces/i);
    } else {
      transcript.push(">> model did not ask a question (no user-input tool used)");
    }
    expect(req).toBeDefined();
  }, 200_000);

  it("F: Stop on a running turn yields exactly one interrupted outcome", async () => {
    const turn = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "Write a very long story of at least 3000 words about rivers.",
      }),
    );
    await waitFor(
      (e) => e.type === "turn.started" && e.turnId === turn.turnId,
      60_000,
      "turn.started",
    );
    await waitFor(
      (e) => e.type === "content.delta" || (e.type === "item.started" && e.turnId === turn.turnId),
      60_000,
      "first output",
    );
    await Effect.runPromise(adapter.interruptTurn(threadId, turn.turnId));
    const done = await completion(turn.turnId, 60_000);
    expect(done.payload.state).toBe("interrupted");
    expect(
      events.filter((e) => e.type === "turn.completed" && e.turnId === turn.turnId),
    ).toHaveLength(1);
  }, 150_000);

  it("G: Stop on a queued turn reclaims it without a start, then stops the runner", async () => {
    const a = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "Write another very long story of at least 3000 words about mountains.",
      }),
    );
    await waitFor((e) => e.type === "turn.started" && e.turnId === a.turnId, 60_000, "A started");
    const b = await Effect.runPromise(
      adapter.sendTurn({ threadId, input: "Reply with the word QUEUED." }),
    );
    expect(b.turnId).not.toBe(a.turnId);
    await Effect.runPromise(adapter.interruptTurn(threadId, b.turnId));
    const bDone = await completion(b.turnId, 60_000);
    expect(bDone.payload.state).toBe("interrupted");
    expect(events.some((e) => e.type === "turn.started" && e.turnId === b.turnId)).toBe(false);
    await Effect.runPromise(adapter.interruptTurn(threadId, a.turnId));
    expect((await completion(a.turnId, 60_000)).payload.state).toBe("interrupted");
    lastCursor = a.resumeCursor;
  }, 200_000);

  it("H: restart resumes the exact native session with memory intact", async () => {
    const before = (lastCursor as { nativeSessionId: string }).nativeSessionId;
    await Effect.runPromise(adapter.stopSession(threadId));
    await waitFor((e) => e.type === "session.exited", 10_000, "session.exited");
    adapter = await makeAdapter();
    const resumed = await Effect.runPromise(
      adapter.startSession({ ...startInput, resumeCursor: lastCursor as never }),
    );
    expect((resumed.resumeCursor as { nativeSessionId: string }).nativeSessionId).toBe(before);
    const turn = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input:
          "At the very start of this conversation I asked you to reply with one specific uppercase word. Reply with that exact word only.",
      }),
    );
    expect((await completion(turn.turnId)).payload.state).toBe("completed");
    expect(assistantText(turn.turnId)).toMatch(/PONG/);
    expect(firstTurnId).toBeTruthy();
    expect(TurnId.makeUnsafe("x")).toBeTruthy();
  }, 200_000);
  it("I: a cursorless restart of a bound session resumes it instead of re-creating", async () => {
    const bound = bindingRow?.nativeSessionId;
    expect(bindingRow?.phase).toBe("bound");
    await Effect.runPromise(adapter.stopSession(threadId));
    adapter = await makeAdapter();
    const restarted = await Effect.runPromise(adapter.startSession(startInput));
    expect((restarted.resumeCursor as { nativeSessionId: string }).nativeSessionId).toBe(bound);
    const turn = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input:
          "At the very start of this conversation I asked you to reply with one specific uppercase word. Reply with that exact word only.",
      }),
    );
    expect((await completion(turn.turnId)).payload.state).toBe("completed");
    expect(assistantText(turn.turnId)).toMatch(/PONG/);
  }, 200_000);
});
