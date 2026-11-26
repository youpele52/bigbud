/**
 * Cross-engine fidelity (plan R1/S4, Q1 criterion (a)): every R1 screen golden restores in
 * `@xterm/headless` with zero diffs outside the rows its snapshot reports as excluded.
 * `BIGBUD_SCREEN_GOLDENS_RANDOM_DIR` adds randomized-stream goldens exported by the crate's
 * `export_random_stream_goldens` test (`BIGBUD_SCREEN_EXPORT_RANDOM=<dir>`).
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compareScreenGolden, loadScreenGoldens } from "./TerminalScreenFidelity.goldens.ts";

const CORPUS = fileURLToPath(
  new URL(
    "../../../../../crates/bigbud-remote-agent/src/terminal_screen/tests/goldens",
    import.meta.url,
  ),
);

describe("R1 screen goldens restore identically in xterm.js", () => {
  const goldens = loadScreenGoldens(CORPUS);

  it("has the whole corpus", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(23);
  });

  it("detects a divergent restore (negative control)", async () => {
    const golden = goldens.find((candidate) => candidate.fixture === "agent_tui_redraw_stream")!;
    const tampered = {
      ...golden,
      snapshot: { ...golden.snapshot, ansi: `${golden.snapshot.ansi}\x1b[1;1HX\x1b[?1h` },
    };
    const diffs = await compareScreenGolden(tampered);
    expect(diffs.some((diff) => diff.startsWith("reference/normal row"))).toBe(true);
    expect(diffs.some((diff) => diff.startsWith("expected/normal row"))).toBe(true);
    expect(diffs.some((diff) => diff.includes("applicationCursorKeysMode"))).toBe(true);
    expect(diffs.some((diff) => diff.startsWith("expected/cursor"))).toBe(true);
  });

  for (const golden of goldens)
    it(golden.fixture, async () => {
      expect(await compareScreenGolden(golden)).toEqual([]);
    });
});

const randomDirectory = process.env.BIGBUD_SCREEN_GOLDENS_RANDOM_DIR;

describe.skipIf(!randomDirectory)("randomized screen goldens (opt-in)", () => {
  it("restores every exported stream, or reports reduced fidelity", async () => {
    const goldens = loadScreenGoldens(randomDirectory!);
    let identical = 0;
    const unexplained: string[] = [];
    for (const [index, golden] of goldens.entries()) {
      const diffs = await compareScreenGolden(golden);
      if (diffs.length === 0) identical += 1;
      else if (golden.snapshot.fidelity === "full")
        unexplained.push(`#${index}: ${diffs[0]!.slice(0, 160)}`);
    }
    const summary = { total: goldens.length, identical, unexplained };
    // Q1 (a): ≥ 99.5% identical, and a sample that differs must report fidelity ≠ `full`.
    expect(summary).toEqual({
      total: goldens.length,
      identical: expect.toSatisfy((count: number) => count >= goldens.length * 0.995),
      unexplained: [],
    });
  });
});
