import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createZshQualification } from "./ZshSuggestions.pty";

describe.skipIf(process.env.BIGBUD_ZSH_QUALIFICATION !== "1" || process.platform !== "darwin")(
  "zsh descriptor/lifecycle fault probes (NOT controller barrier or D_safe proof)",
  () => {
    it("processes fragmented and coalesced frames without another readiness edge", async () => {
      const probe = await createZshQualification();
      try {
        const deadline = (await probe.snapshot()).clock + 0.9;
        const frame = probe.encodeFrame("grant", deadline, 1);
        await probe.rawFrame(frame.slice(0, 12));
        await delay(30);
        expect((await probe.snapshot()).suspended).toBe(1);
        await probe.rawFrame(frame.slice(12) + probe.encodeFrame("suspend", 0, 2));
        await expect.poll(async () => (await probe.snapshot()).sequence).toBe(2);
        expect((await probe.snapshot()).revoked).toBe(1);
        expect(await probe.readStatus()).toMatch(/ 2 suspended \d+\n$/);
      } finally {
        await probe.dispose();
      }
    });

    it.each([0, 260, 1100])(
      "lost ACK cannot rearm an invalidated shell at %i ms",
      async (elapsed) => {
        const probe = await createZshQualification();
        try {
          const deadline = (await probe.snapshot()).clock + 0.9;
          const seq = await probe.frame("grant", deadline);
          await expect.poll(async () => (await probe.snapshot()).sequence).toBe(seq);
          probe.write("print -r");
          await expect.poll(async () => (await probe.snapshot()).display).not.toBe("");
          await probe.frame("suspend", 0);
          await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
          // Deliberately do not consume the ACK. This is shell evidence, not input-queue evidence.
          await delay(elapsed);
          await probe.frame("grant", deadline);
          probe.write("\t\u001b[C");
          await expect.poll(async () => (await probe.snapshot()).rights).toBe(1);
          expect((await probe.snapshot()).tabs).toBe(1);
          expect((await probe.snapshot()).accepts).toBe(0);
          expect((await probe.snapshot()).suspended).toBe(1);
        } finally {
          await probe.dispose();
        }
      },
    );

    it("delayed still-valid absolute renewal does not extend its encoded deadline", async () => {
      const probe = await createZshQualification();
      try {
        const deadline = (await probe.snapshot()).clock + 0.9;
        const initial = await probe.frame("grant", deadline);
        await expect.poll(async () => (await probe.snapshot()).sequence).toBe(initial);
        probe.write("print -r");
        await expect.poll(async () => (await probe.snapshot()).display).not.toBe("");
        const start = performance.now();
        await delay(350);
        const seq = await probe.frame("grant", deadline);
        await expect.poll(async () => (await probe.snapshot()).sequence).toBe(seq);
        expect((await probe.snapshot()).deadline).toBeCloseTo(deadline, 6);
        await delay(650);
        probe.write("\u001b[C");
        await expect.poll(async () => (await probe.snapshot()).rights).toBe(1);
        const state = await probe.snapshot();
        expect(state.accepts).toBe(0);
        expect(state.clock).toBeGreaterThanOrEqual(deadline);
        expect(performance.now() - start).toBeGreaterThanOrEqual(1000);
        // Observed elapsed time does not establish a monotonic/transport upper bound.
      } finally {
        await probe.dispose();
      }
    });

    it("passes Tab/Right to a foreground read without accepting or sending control frames", async () => {
      const probe = await createZshQualification();
      try {
        await probe.grant();
        probe.write('IFS= read -r "reply?foreground> "; print -r -- "$reply" > "$HOME/reply"\r');
        await expect.poll(() => probe.screen()).toContain("foreground> ");
        await probe.frame("suspend", 0);
        probe.write("\t\u001b[C\r");
        await expect.poll(() => readFile(join(probe.home, "reply"), "utf8")).toBe("\t\u001b[C\n");
        await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
      } finally {
        await probe.dispose();
      }
    });

    it("does not interpret accepting keys embedded in bracketed paste as widgets", async () => {
      const probe = await createZshQualification();
      try {
        await probe.grant();
        probe.write("\u001b[200~print -r\t\u001b[C\u001b[201~");
        await expect.poll(async () => (await probe.snapshot()).buffer).toContain("print -r");
        const state = await probe.snapshot();
        expect(state.accepts).toBe(0);
        expect(state.tabs + state.rights).toBe(0);
        expect(state.display).toBe("");
        // This does not prove browser composition or suspension before an ordinary paste.
      } finally {
        await probe.dispose();
      }
    });
  },
);
