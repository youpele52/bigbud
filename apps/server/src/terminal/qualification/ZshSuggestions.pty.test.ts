import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createZshQualification } from "./ZshSuggestions.pty";

type Probe = Awaited<ReturnType<typeof createZshQualification>>;

async function grant(probe: Probe) {
  await probe.grant();
}
async function type(probe: Probe, buffer: string) {
  probe.write(buffer);
  await expect.poll(async () => (await probe.snapshot()).buffer).toBe(buffer);
}

// Explicit opt-in: local real PTY evidence, not a portable unit test or full G1.
describe.skipIf(process.env.BIGBUD_ZSH_QUALIFICATION !== "1" || process.platform !== "darwin")(
  "isolated zsh shell-side qualification (NOT full G1/G2)",
  () => {
    it.each(["\u001b[C", "\t"])("%j accepts only rendered suffix, never executes", async (key) => {
      const probe = await createZshQualification();
      try {
        await grant(probe);
        await type(probe, "print -r");
        await expect
          .poll(async () => (await probe.snapshot()).display)
          .toBe(" -- QUALIFIED; : literal-punctuation  →");
        const before = await probe.snapshot();
        probe.write(key);
        await expect.poll(async () => (await probe.snapshot()).accepts).toBe(1);
        const after = await probe.snapshot();
        expect(after.buffer).toBe("print -r -- QUALIFIED; : literal-punctuation");
        expect(after.cursor).toBe(after.buffer.length);
        expect(after.display).toBe("");
        expect(after.revision).toBeGreaterThan(before.revision);
        // A still-populated ZLE buffer proves acceptance did not call accept-line.
        expect(await readFile(join(probe.home, "history"), "utf8")).toBe("");
      } finally {
        await probe.dispose();
      }
    });

    it("filters unsafe history, preserves Unicode, and delegates midline Right once", async () => {
      const probe = await createZshQualification();
      try {
        await grant(probe);
        await type(probe, "print bad");
        expect((await probe.snapshot()).display).toBe("");
        probe.write("\u0015print uni");
        await expect.poll(async () => (await probe.snapshot()).display).toBe("code-λ  →");
        probe.write("\u0002"); // Original backward-char changes the rendered revision.
        await expect.poll(async () => (await probe.snapshot()).cursor).toBe(8);
        expect((await probe.snapshot()).display).toBe("");
        probe.write("\u001b[C");
        await expect.poll(async () => (await probe.snapshot()).rights).toBe(1);
        expect((await probe.snapshot()).buffer).toBe("print uni");
        expect((await probe.snapshot()).accepts).toBe(0);
        probe.write("x\t");
        await expect.poll(async () => (await probe.snapshot()).tabs).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
      } finally {
        await probe.dispose();
      }
    });

    it.each(["\t", "\u001b[C"])(
      "%j independently rejects expiry while ZLE has had no callback/redraw",
      async (key) => {
        const probe = await createZshQualification();
        try {
          await grant(probe);
          await type(probe, "print -r");
          const rendered = await probe.snapshot();
          expect(rendered.display).not.toBe("");
          await delay(1100);
          // No app expiry callback or automatic redraw cleared the rendered tuple.
          expect(await probe.snapshot()).toEqual(rendered);
          probe.write(key);
          await expect
            .poll(async () => {
              const state = await probe.snapshot();
              return state.tabs + state.rights;
            })
            .toBe(1);
          expect((await probe.snapshot()).accepts).toBe(0);
        } finally {
          await probe.dispose();
        }
      },
    );

    it("ACKs private-descriptor invalidation, then rejects delayed/replayed grants", async () => {
      const probe = await createZshQualification();
      try {
        await grant(probe);
        await type(probe, "print -r");
        const { clock } = await probe.snapshot();
        const seq = await probe.frame("suspend", 0);
        await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
        const ack = await probe.readStatus();
        expect(ack).toMatch(new RegExp(`^v1 [\\w-]+ [\\w-]+ ${seq} suspended \\d+\\n$`));
        expect(ack).not.toContain("print");
        expect((await probe.snapshot()).display).toBe("");
        // Newer delayed grant and replay cannot resurrect this revoked lease.
        await probe.frame("grant", clock + 0.9);
        await expect.poll(async () => (await probe.snapshot()).sequence).toBe(seq + 1);
        await probe.frame("grant", clock + 0.9, 1);
        probe.write("\u001b[C\t");
        await expect.poll(async () => (await probe.snapshot()).tabs).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
        expect((await probe.snapshot()).suspended).toBe(1);
      } finally {
        await probe.dispose();
      }
    });

    it("rejects expired receipt-relative renewal and fails closed on EOF", async () => {
      const probe = await createZshQualification();
      try {
        await grant(probe);
        await type(probe, "print -r");
        const { deadline } = await probe.snapshot();
        await delay(1100);
        await probe.frame("grant", deadline);
        await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
        await probe.closeControl();
        probe.write("\u001b[C");
        await expect.poll(async () => (await probe.snapshot()).rights).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
      } finally {
        await probe.dispose();
      }
    });

    it("uses private FIFOs and invalidates an active lease on controller EOF", async () => {
      const probe = await createZshQualification();
      try {
        expect((await stat(probe.home)).mode & 0o777).toBe(0o700);
        expect((await stat(join(probe.home, "runtime"))).mode & 0o777).toBe(0o700);
        for (const name of ["control", "status"]) {
          const fifo = await stat(join(probe.home, "runtime", name));
          expect(fifo.isFIFO()).toBe(true);
          expect(fifo.mode & 0o777).toBe(0o600);
        }
        await grant(probe);
        await type(probe, "print -r");
        await probe.closeControl();
        await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
        expect((await probe.snapshot()).display).toBe("");
        probe.write("\t");
        await expect.poll(async () => (await probe.snapshot()).tabs).toBe(1);
        expect((await probe.snapshot()).accepts).toBe(0);
      } finally {
        await probe.dispose();
      }
    });

    it.each(["v9 invalid\n", "x".repeat(257)])(
      "fails closed on malformed/oversized control",
      async (frame) => {
        const probe = await createZshQualification();
        try {
          await grant(probe);
          await type(probe, "print -r");
          await probe.rawFrame(frame);
          await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
          probe.write("\u001b[C");
          await expect.poll(async () => (await probe.snapshot()).rights).toBe(1);
          expect((await probe.snapshot()).accepts).toBe(0);
        } finally {
          await probe.dispose();
        }
      },
    );
  },
);
