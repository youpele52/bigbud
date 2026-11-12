import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createZshQualification } from "./ZshSuggestions.pty";

// Negative qualification evidence, not a production acceptance test. Passing means
// the current SECONDS-based prototype demonstrably FAILS the monotonic-clock gate.
// Only the disposable shell parameter changes; the host clock is never changed.
describe.skipIf(process.env.BIGBUD_ZSH_QUALIFICATION !== "1" || process.platform !== "darwin")(
  "G1 rejection evidence: resettable SECONDS cannot establish lease expiry",
  () => {
    it.each(["tab", "right"])(
      "%s can accept an old rendered tuple after elapsed expiry when the clock rolls back",
      async (widget) => {
        const probe = await createZshQualification({
          startup: {
            ".zshrc": [
              // Run rollback and the actual acceptance predicate in one widget,
              // before any pre-redraw can erase the old rendered tuple.
              `q_clock_fault() { SECONDS=$((q_deadline - 0.1)); q_accept ${widget}; q_snapshot; }`,
              "zle -N q_clock_fault",
              "bindkey '^G' q_clock_fault",
            ].join("\n"),
          },
        });
        try {
          await probe.grant();
          probe.write("print -r");
          // A partial prefix can already render a candidate. Wait for the complete
          // PTY edit and its redraw before capturing the tuple used by the fault probe.
          await expect
            .poll(() => probe.snapshot())
            .toMatchObject({
              buffer: "print -r",
              cursor: 8,
              display: " -- QUALIFIED; : literal-punctuation  →",
              accepts: 0,
              tabs: 0,
              rights: 0,
            });
          const rendered = await probe.snapshot();
          const started = performance.now();
          await delay(1100);
          expect(performance.now() - started).toBeGreaterThanOrEqual(1100);
          expect(await probe.snapshot()).toEqual(rendered);
          probe.write("\u0007");
          await expect.poll(async () => (await probe.snapshot()).accepts).toBe(1);
          const after = await probe.snapshot();
          expect(after.buffer).toBe("print -r -- QUALIFIED; : literal-punctuation");
          expect(after.deadline).toBe(rendered.deadline);
          expect(after.tabs + after.rights).toBe(0);
          // This is insertion only; no Enter or command execution is requested.
          // Never use this passing negative probe as a G1 qualification pass.
        } finally {
          await probe.dispose();
        }
      },
    );
  },
);
