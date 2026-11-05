import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type {
  TerminalRecoveryInput,
  TerminalRecoveryResult,
} from "@bigbud/contracts/workspace/terminal.recovery.ts";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { deferRecoveryFit, terminalResizeGeometry } from "./terminalRecoveryGeometry";

const snapshot: TerminalSessionSnapshot = {
  threadId: "recovery",
  terminalId: "default",
  runtimeGeneration: "generation",
  cwd: "/",
  worktreePath: null,
  dropPathMode: "posix",
  status: "running",
  pid: 123,
  history: "",
  historyTruncated: true,
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const frame = {
  generation: "generation",
  sequence: 0,
  cols: 80,
  rows: 24,
  ansi: "restored",
  pendingEscapeTail: "",
  scrollbackRows: 0,
};
function setup(request: (input: TerminalRecoveryInput) => Promise<TerminalRecoveryResult>) {
  const terminal = new Terminal({ cols: 90, rows: 30, allowProposedApi: true });
  const failure = vi.fn();
  const attached = vi.fn();
  const lane = new TerminalWriteBatcher(failure);
  const intake = new TerminalViewportIntake(
    terminal,
    lane,
    (event) => {
      if (event.type === "output") lane.write(terminal, event.data);
    },
    () => undefined,
    () => undefined,
    () => true,
    request,
    attached,
  );
  const replies: string[] = [];
  const listener = terminal.onData((data) => {
    if (intake.acceptsInput) replies.push(data);
  });
  return {
    terminal,
    lane,
    intake,
    failure,
    attached,
    replies,
    close: () => {
      intake.dispose();
      lane.dispose();
      listener.dispose();
      terminal.dispose();
    },
  };
}

it("suppresses historical replies, restores parser tail last, and consumes each ordered suffix exactly once", async () => {
  const request = vi.fn(async (input: TerminalRecoveryInput): Promise<TerminalRecoveryResult> => {
    if (!input.after)
      return {
        type: "snapshot",
        frame: { ...frame, ansi: "\x1b[6n", pendingEscapeTail: "\x1b[3" },
      };
    return {
      type: "suffix",
      through: { generation: "generation", sequence: 3 },
      records:
        input.after.sequence === 0
          ? [
              { type: "output", generation: "generation", sequence: 1, data: "2mGREEN" },
              { type: "resize", generation: "generation", sequence: 2, cols: 100, rows: 28 },
              { type: "output", generation: "generation", sequence: 3, data: "\x1b[6n" },
            ]
          : [],
    };
  });
  const t = setup(request);
  try {
    await t.intake.hydrate(snapshot);
    t.intake.receive({
      type: "output",
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      createdAt: "2026-11-01T00:00:01.000Z",
      data: "DUPLICATE\x1b[6n",
    });
    await expect.poll(() => t.replies.length).toBe(1);
    expect(t.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("GREEN");
    expect(t.terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(2);
    expect([t.terminal.cols, t.terminal.rows]).toEqual([100, 28]);
    expect(t.failure).not.toHaveBeenCalled();
  } finally {
    t.close();
  }
});

it.each(["unsupported", "stale"])(
  "keeps existing cells and geometry, and attaches live, on %s snapshot refusal",
  async (kind) => {
    const t = setup(async () =>
      kind === "unsupported"
        ? { type: "unavailable", reason: "saved-cursor-not-qualified" }
        : { type: "snapshot", frame: { ...frame, generation: "retired" } },
    );
    try {
      await new Promise<void>((done) => t.terminal.write("existing healthy view", done));
      await t.intake.hydrate(snapshot);
      expect(t.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
        "existing healthy view",
      );
      expect([t.terminal.cols, t.terminal.rows]).toEqual([90, 30]);
      expect(t.intake.acceptsInput).toBe(true);
      expect(t.attached).toHaveBeenCalledOnce();
      expect(t.failure).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  },
);

it("does not replace an already healthy mounted view when legacy history expires", async () => {
  const request = vi.fn(
    async (): Promise<TerminalRecoveryResult> => ({ type: "unavailable", reason: "unsupported" }),
  );
  const t = setup(request);
  try {
    await t.intake.hydrate({ ...snapshot, history: "healthy", historyTruncated: false });
    await t.intake.hydrate({ ...snapshot, updatedAt: "2026-11-01T00:00:02.000Z" });
    expect(t.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("healthy");
    expect(t.intake.acceptsInput).toBe(true);
    expect(request).not.toHaveBeenCalled();
  } finally {
    t.close();
  }
});

it("rejects a suffix gap before applying any of its bytes, then stays live", async () => {
  const t = setup(async (input) =>
    !input.after
      ? { type: "snapshot", frame }
      : {
          type: "suffix",
          through: { generation: "generation", sequence: 2 },
          records: [{ type: "output", generation: "generation", sequence: 2, data: "BAD" }],
        },
  );
  try {
    await t.intake.hydrate(snapshot);
    await expect.poll(() => t.attached.mock.calls.length).toBe(1);
    expect(t.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("restored");
    await expect.poll(() => t.intake.acceptsInput).toBe(true);
    expect(t.failure).not.toHaveBeenCalled();
    t.intake.receive({
      type: "output",
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      createdAt: "2026-11-01T00:00:01.000Z",
      data: " live",
    });
    await expect
      .poll(() => t.terminal.buffer.active.getLine(0)?.translateToString(true))
      .toBe("restored live");
  } finally {
    t.close();
  }
});

it("defers local fit until the ordered resize, so preceding output uses its original geometry", async () => {
  const t = setup(async (input) =>
    !input.after
      ? { type: "snapshot", frame: { ...frame, cols: 5, rows: 3, ansi: "1234" } }
      : {
          type: "suffix",
          through: { generation: "generation", sequence: 2 },
          records:
            input.after.sequence === 0
              ? [
                  { type: "output", generation: "generation", sequence: 1, data: "AB\x1b[6n" },
                  { type: "resize", generation: "generation", sequence: 2, cols: 10, rows: 4 },
                ]
              : [],
        },
  );
  try {
    await t.intake.hydrate(snapshot);
    expect(deferRecoveryFit(t.terminal, { proposeDimensions: () => ({ cols: 10, rows: 4 }) })).toBe(
      true,
    );
    expect(terminalResizeGeometry(t.terminal)).toEqual({ cols: 10, rows: 4 });
    expect([t.terminal.cols, t.terminal.rows]).toEqual([5, 3]);
    await expect.poll(() => t.replies).toEqual(["\x1b[2;2R"]);
    await expect.poll(() => [t.terminal.cols, t.terminal.rows]).toEqual([10, 4]);
  } finally {
    t.close();
  }
});
