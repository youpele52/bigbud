/**
 * Workload for the terminal host soak (plan Q1 (b)): agent-like TUI floods (alternate screen,
 * hidden cursor, coloured full redraws at a steady rate) and prompt terminals that receive
 * randomized probes (colours, wide and combining text, cursor moves, erases) whose restored
 * screens are compared cell by cell with a reference xterm.js fed the same output.
 *
 * @module terminalHostSoak.workload
 */
import type { Terminal } from "@xterm/headless";

import {
  captureNormalizedScreen,
  makeFidelityTerminal,
  writeAsync,
  type NormalizedScreen,
} from "../src/terminal/Layers/TerminalScreenFidelity.goldens.ts";

/** A shell loop that redraws a coloured alternate screen every `sleepSeconds`. */
export function tuiFloodCommand(rows: number, sleepSeconds: number): string {
  const body = Array.from({ length: Math.max(1, rows - 3) }, (_, row) => row + 1).join(" ");
  return (
    "printf '\\033[?1049h\\033[?25l'; i=0; while :; do i=$((i+1)); " +
    "printf '\\033[H\\033[1;35m agent \\033[0m frame %d \\033[K\\n' \"$i\"; " +
    `for r in ${body}; do printf '\\033[3%dm row %03d %s\\033[0m\\033[K\\n' $(( (i+r) % 7 + 1 )) "$r" "$i"; done; ` +
    `printf '> working…\\033[K'; sleep ${sleepSeconds}; done\r`
  );
}

const PIECES = [
  "\\033[1mbold\\033[0m",
  "\\033[3;4mitalic-under\\033[0m",
  "\\033[7minverse\\033[0m",
  "\\033[38;5;208morange\\033[0m",
  "\\033[38;2;10;200;90mtruecolor\\033[0m",
  "\\033[44mblue-bg\\033[0m",
  "中文",
  "e\\314\\201",
  "\\342\\234\\223",
  "plain",
  "\\033[2K",
  "\\033[3C",
  "\\033[1A\\033[1B",
];

/** A random `printf` probe ending in a unique sentinel line; returns the command and sentinel. */
export function fidelityProbe(random: () => number, serial: number) {
  const parts: string[] = [];
  const count = 4 + Math.floor(random() * 12);
  for (let index = 0; index < count; index++) {
    parts.push(PIECES[Math.floor(random() * PIECES.length)]!);
    if (random() < 0.3) parts.push("\\n");
    else parts.push(" ");
  }
  const sentinel = `probe-done-${serial}`;
  return { command: `printf '${parts.join("")}\\n'; echo ${sentinel}\r`, sentinel };
}

/** A deterministic PRNG (mulberry32), so a soak can be replayed with the same seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A live reference xterm.js per prompt terminal, fed every output event in order. */
export class ReferenceScreens {
  private readonly terminals = new Map<string, Terminal>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly geometry: { cols: number; rows: number }) {}

  feed(key: string, data: string): void {
    let terminal = this.terminals.get(key);
    if (!terminal) {
      terminal = makeFidelityTerminal({ ...this.geometry, scrollback: 1000 });
      this.terminals.set(key, terminal);
    }
    const target = terminal;
    const previous = this.pending.get(key) ?? Promise.resolve();
    this.pending.set(
      key,
      previous.then(() => writeAsync(target, data)),
    );
  }

  async capture(key: string): Promise<NormalizedScreen | undefined> {
    await this.pending.get(key);
    const terminal = this.terminals.get(key);
    return terminal ? captureNormalizedScreen(terminal) : undefined;
  }

  dispose(): void {
    for (const terminal of this.terminals.values()) terminal.dispose();
    this.terminals.clear();
  }
}

/** Renders a screen item's ANSI on a fresh terminal at its geometry. */
export async function renderScreenItem(
  ansi: string,
  geometry: { cols: number; rows: number },
): Promise<NormalizedScreen> {
  const terminal = makeFidelityTerminal({ ...geometry, scrollback: 1000 });
  try {
    await writeAsync(terminal, ansi);
    return captureNormalizedScreen(terminal);
  } finally {
    terminal.dispose();
  }
}

/** Visible rows, cursor and modes; scrollback is not compared (it may be trimmed). */
export function visibleDiffers(
  reference: NormalizedScreen,
  restored: NormalizedScreen,
  rows: number,
): boolean {
  const visible = (screen: NormalizedScreen) =>
    JSON.stringify(screen.alternate ?? screen.normal.slice(-rows));
  return (
    visible(reference) !== visible(restored) ||
    JSON.stringify(reference.cursor) !== JSON.stringify(restored.cursor) ||
    JSON.stringify(reference.modes) !== JSON.stringify(restored.modes)
  );
}
