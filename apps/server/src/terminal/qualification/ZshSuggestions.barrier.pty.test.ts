import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { makeQualificationInputBarrier } from "./ZshSuggestions.barrier";
import { createZshQualification } from "./ZshSuggestions.pty";

// Synthetic disposable-HOME rehearsal only. No production queue, browser/IME,
// cross-clock expiry bound, real user plugins, or packaged adapter is qualified.
describe.skipIf(process.env.BIGBUD_ZSH_QUALIFICATION !== "1" || process.platform !== "darwin")(
  "real zsh matched-ACK barrier rehearsal (NOT full G1/G2)",
  () => {
    it.each([260, 1100])(
      "withholds input at %i ms until the matching private ACK is delivered",
      async (elapsed) => {
        const probe = await createZshQualification();
        try {
          await probe.grant();
          probe.write("print -r");
          await expect.poll(async () => (await probe.snapshot()).display).not.toBe("");
          const sequence = 7;
          const [, session, lease] = probe.encodeFrame("suspend", 0, sequence).split(" ");
          const writes: string[] = [];
          const barrier = makeQualificationInputBarrier({
            session: session!,
            lease: lease!,
            sequence,
            write: (data) => {
              writes.push(data);
              probe.write(data);
            },
          });
          barrier.enqueue("\t");
          barrier.enqueue("\u001b[C");
          await probe.frame("suspend", 0, sequence);
          await expect.poll(async () => (await probe.snapshot()).revoked).toBe(1);
          // Leave the real invalidation ACK in the private descriptor unread.
          await delay(elapsed);
          barrier.timeout();
          barrier.status(`v1 ${session} other-lease ${sequence} suspended 1\n`);
          barrier.status(`v1 ${session} ${lease} ${sequence - 1} suspended 1\n`);
          expect(barrier.state).toBe("blocked");
          expect(writes).toEqual([]);
          expect((await probe.snapshot()).accepts).toBe(0);
          expect((await probe.snapshot()).tabs + (await probe.snapshot()).rights).toBe(0);
          await expect
            .poll(async () => {
              barrier.status(await probe.readStatus());
              return barrier.state;
            })
            .toBe("released");
          expect(writes).toEqual(["\t", "\u001b[C"]);
          await expect.poll(async () => (await probe.snapshot()).rights).toBe(1);
          expect((await probe.snapshot()).tabs).toBe(1);
          expect((await probe.snapshot()).accepts).toBe(0);
          expect((await probe.snapshot()).display).toBe("");
        } finally {
          await probe.dispose();
        }
      },
    );
  },
);
