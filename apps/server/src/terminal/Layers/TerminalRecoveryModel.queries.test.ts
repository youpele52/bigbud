import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTerminalRecoveryModel, type TerminalRecoveryModel } from "./TerminalRecoveryModel";
import { TerminalRecoveryQueries } from "./TerminalRecoveryModel.queries";
import { Terminal } from "@xterm/headless";

const models: TerminalRecoveryModel[] = [];
beforeEach(() => vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", "1"));
afterEach(() => {
  models.forEach((model) => model.dispose());
  models.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function model() {
  const result = createTerminalRecoveryModel("generation", 80, 24)!;
  models.push(result);
  return result;
}

it("refuses a cut with an unanswered renderer query, then admits the acknowledged cut", async () => {
  const mirror = model();
  mirror.write("abc\x1b[6n");
  expect(await mirror.capture()).toEqual({ type: "unavailable", reason: "pending-renderer-query" });
  mirror.observeInput("\x1b[1;");
  mirror.observeInput("4R");
  expect((await mirror.capture()).type).toBe("candidate");
});

it("recognizes the renderer's palette reply without adopting headless colors or sending input", async () => {
  const mirror = model();
  mirror.write("\x1b]11;?\x07");
  expect(await mirror.capture()).toEqual({ type: "unavailable", reason: "pending-renderer-query" });
  mirror.observeInput("\x1b]11;rgb:1234/5678/9abc\x1b\\");
  expect((await mirror.capture()).type).toBe("candidate");
});

it("accounts for replies preceding asynchronous model parsing, but not preceding native ingress", () => {
  const queries = new TerminalRecoveryQueries();
  queries.observe("\x1b[1;4R", 0);
  queries.expect("\x1b[1;4R", 1);
  expect(queries.pending).toBe(true);
  queries.observe("\x1b[1;4R", 1);
  expect(queries.pending).toBe(false);
  queries.observe("\x1b[1;8R", 2);
  queries.expect("\x1b[1;8R", 2);
  expect(queries.pending).toBe(false);
});

it("uses the renderer version rather than requiring the headless build's version label", async () => {
  const mirror = model();
  mirror.write("\x1b[>0q");
  expect(await mirror.capture()).toEqual({ type: "unavailable", reason: "pending-renderer-query" });
  mirror.observeInput("\x1bP>|xterm.js(6.1.0-beta.304)\x1b\\");
  expect((await mirror.capture()).type).toBe("candidate");
});

it("does not acknowledge two queries from one reply and refuses an overflowing ledger", () => {
  const queries = new TerminalRecoveryQueries();
  queries.expect("\x1b[0n", 1);
  queries.expect("\x1b[0n", 2);
  queries.observe("\x1b[0n", 2);
  expect(queries.pending).toBe(true);
  queries.observe("\x1b[0n", 2);
  expect(queries.pending).toBe(false);
  for (let i = 0; i < 65; i++) queries.expect("\x1b[0n", 3);
  queries.observe("\x1b[0n".repeat(65), 3);
  expect(queries.pending).toBe(true);
});

it("keeps snapshots available beyond 8 MiB of ordinary redraws", async () => {
  const mirror = model();
  for (let i = 0; i < 300; i++) {
    mirror.write("\x1b[H" + "x".repeat(32768));
    expect((await mirror.capture()).type).toBe("candidate");
  }
  expect((await mirror.capture()).type).toBe("candidate");
  const cut = mirror.records.cursor;
  mirror.write("still-live\x1b[6n");
  mirror.resize(90, 30);
  await mirror.capture();
  const suffix = mirror.records.after(cut);
  expect(suffix.type === "suffix" && suffix.records.map((record) => record.type)).toEqual([
    "output",
    "resize",
  ]);
  expect(mirror.unavailableReason).toBeNull();
});

it.each(["\u0301", "\u1161", "\u200d", "\u{1f3fb}"])(
  "refuses excessive combination contributions before xterm allocation (%s)",
  async (mark) => {
    const mirror = model();
    const writes = vi.spyOn(Terminal.prototype, "write");
    mirror.write("x" + mark.repeat(32768));
    expect(await mirror.capture()).toEqual({
      type: "unavailable",
      reason: "unicode-combination-budget",
    });
    expect(writes).not.toHaveBeenCalled();
    const cut = mirror.records.cursor;
    mirror.write("still-live");
    await mirror.capture();
    expect(mirror.records.after(cut).type).toBe("suffix");
  },
);

it("preserves ordered delivery when a resize retires snapshot admission", async () => {
  const mirror = model();
  const cut = mirror.records.cursor;
  mirror.resize(1000, 500);
  mirror.write("live");
  expect(await mirror.capture()).toEqual({ type: "unavailable", reason: "resize-admission" });
  const suffix = mirror.records.after(cut);
  expect(suffix.type === "suffix" && suffix.records.map((record) => record.type)).toEqual([
    "resize",
    "output",
  ]);
  expect(mirror.unavailableReason).toBeNull();
});

it("preserves raw delivery when an oversized partial control retires capture", async () => {
  const mirror = model();
  const cut = mirror.records.cursor;
  mirror.write("\x1b]0;" + "x".repeat(17000));
  expect(await mirror.capture()).toEqual({ type: "unavailable", reason: "parser-tail-budget" });
  mirror.write("\x07live");
  await mirror.capture();
  const suffix = mirror.records.after(cut);
  expect(suffix.type === "suffix" && suffix.records.map((record) => record.type)).toEqual([
    "output",
    "output",
  ]);
  expect(mirror.unavailableReason).toBeNull();
});

it("keeps answered query traffic eligible, but never ages out an unanswered query", () => {
  const queries = new TerminalRecoveryQueries();
  for (let sequence = 1; sequence <= 1000; sequence++) {
    queries.expect("\x1b[0n", sequence);
    queries.observe("\x1b[0n", sequence);
    expect(queries.pending).toBe(false);
  }
  queries.expect("\x1b[1;1R", 1001);
  for (let sequence = 1002; sequence < 1100; sequence++) {
    queries.expect("\x1b[0n", sequence);
    queries.observe("\x1b[0n", sequence);
  }
  expect(queries.pending).toBe(true);
});

it("documents the remaining Unicode admission blocker even when old cells are erased", async () => {
  const mirror = model();
  mirror.write("\x1b[2J\x1b[Hx\u0301".repeat(1024));
  expect((await mirror.capture()).type).toBe("candidate");
  mirror.write("\x1b[2J\x1b[Hx\u0301");
  expect(await mirror.capture()).toEqual({
    type: "unavailable",
    reason: "unicode-combination-budget",
  });
});
