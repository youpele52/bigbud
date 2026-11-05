import { Terminal } from "@xterm/headless";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateTerminalUnicodeProvider } from "@bigbud/shared/terminalUnicodeProvider";
import { Unicode11Addon } from "./TerminalRecoveryModel.addons.mjs";
import { createTerminalRecoveryModel, type TerminalRecoveryModel } from "./TerminalRecoveryModel";
import {
  RECOVERY_CLUSTER_JOINERS,
  TerminalRecoveryUnicodeAdmission,
} from "./TerminalRecoveryModel.combinations";
import { RECOVERY_COMBINED_BYTES } from "./TerminalRecoveryModel.budget";

const models: TerminalRecoveryModel[] = [];
const terminals: Terminal[] = [];
beforeEach(() => vi.stubEnv("BIGBUD_TERMINAL_RECOVERY", "1"));
afterEach(() => {
  models.forEach((model) => model.dispose());
  terminals.forEach((terminal) => terminal.dispose());
  models.length = 0;
  terminals.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function model(cols = 80, rows = 24) {
  const result = createTerminalRecoveryModel("generation", cols, rows)!;
  models.push(result);
  return result;
}
/** The production terminal profile without the model, to inspect admission directly. */
function headless(cols = 80, rows = 24) {
  const terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  activateTerminalUnicodeProvider(terminal);
  terminals.push(terminal);
  return { terminal, admission: new TerminalRecoveryUnicodeAdmission(terminal) };
}
const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

it.each(["\u0301", "\u1161", "\u200d", "\u{e0067}"])(
  "retires an over-long cluster before xterm allocates it (%s)",
  async (mark) => {
    const mirror = model();
    const writes = vi.spyOn(Terminal.prototype, "write");
    mirror.write("x" + mark.repeat(RECOVERY_CLUSTER_JOINERS + 1));
    expect(await mirror.capture()).toEqual({
      type: "unavailable",
      reason: "unicode-cluster-budget",
    });
    expect(writes).not.toHaveBeenCalled();
    const cut = mirror.records.cursor;
    mirror.write("still-live");
    await mirror.capture();
    expect(mirror.records.after(cut).type).toBe("suffix");
  },
);

it("admits real clusters and ignores width-2 modifiers that xterm never joins", async () => {
  const mirror = model();
  const family = "\u{1f469}\u{1f3fd}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}";
  const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}";
  mirror.write(`${family} ${flag} e\u0301 \u2714\ufe0f ` + "\u{1f3fb}".repeat(32768) + "\r\n");
  expect((await mirror.capture()).type).toBe("candidate");
});

it("stays available across sustained combined-cell redraws with flat retained strings", async () => {
  const mirror = model();
  const { terminal, admission } = headless();
  const cells = "\u2714\ufe0f e\u0301 \u{1f44d}\u{1f3fd} ".repeat(200);
  const samples: number[] = [];
  for (let round = 0; round < 400; round++) {
    // Overwrite without clearing, shifting a column on odd rounds, so plain cells land on old
    // combined ones and leave stale sparse entries, the case a visible-cell count would miss.
    const frame = (round % 2 ? "\x1b[H " : "\x1b[H") + cells;
    mirror.write(frame);
    expect(admission.admit(frame)).toBeNull();
    await write(terminal, frame);
    samples.push(admission.retainedBytes());
  }
  expect((await mirror.capture()).type).toBe("candidate");
  // Redraws replace strings in place; only the first frames may add stale sparse entries.
  expect(Math.max(...samples.slice(10))).toBe(samples.at(-1));
  expect(samples.at(-1)!).toBeLessThan(RECOVERY_COMBINED_BYTES / 8);
});

it("retires capture when retained strings exceed the audited budget, keeping delivery", async () => {
  const mirror = model(200, 50);
  const cut = mirror.records.cursor;
  const line = "e\u0301".repeat(200);
  for (let round = 0; round < 500; round++) mirror.write(line);
  mirror.write("live");
  expect(await mirror.capture()).toEqual({
    type: "unavailable",
    reason: "unicode-retained-budget",
  });
  const suffix = mirror.records.after(cut);
  expect(suffix.type === "suffix" && suffix.records.length).toBe(501);
  expect(mirror.unavailableReason).toBeNull();
});

it("bounds REP allocation before parsing, including a parameter split across writes", async () => {
  const plain = model();
  plain.write("x\x1b[64b");
  expect((await plain.capture()).type).toBe("candidate");

  const huge = model();
  const writes = vi.spyOn(Terminal.prototype, "write");
  huge.write("x\x1b[214748");
  expect(writes).toHaveBeenCalledTimes(1);
  huge.write("3647b");
  expect(await huge.capture()).toEqual({ type: "unavailable", reason: "rep-expansion-budget" });
  expect(writes).toHaveBeenCalledTimes(1);

  const joined = model();
  joined.write("x\u200d\x1b[40b");
  expect(await joined.capture()).toEqual({
    type: "unavailable",
    reason: "unicode-cluster-budget",
  });
});

it("counts private-prefixed or intermediate CSI b as a different control, not REP", () => {
  const { admission } = headless();
  expect(admission.admit("x\x1b[?2147483647b\x1b[2147483647 b")).toBeNull();
});

it("follows clusters split inside a surrogate pair across writes", () => {
  const { admission } = headless();
  const tags = "\u{e0067}".repeat(RECOVERY_CLUSTER_JOINERS + 1);
  let result: string | null = admission.admit("x");
  // Every write ends between a high and a low surrogate.
  for (let index = 0; index < tags.length && !result; index++)
    result = admission.admit(tags.charAt(index));
  expect(result).toBe("unicode-cluster-budget");

  const split = headless().admission;
  let failure: string | null = split.admit("x\ud83c");
  for (let index = 0; index < 40 && !failure; index++) failure = split.admit("\udfff\ud83c");
  // U+1F3FF is width 2 and never joins, so this stream is admitted.
  expect(failure).toBeNull();
});
