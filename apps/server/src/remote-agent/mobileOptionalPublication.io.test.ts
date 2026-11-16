import {
  publicationFixture,
  publicationWiring,
} from "./mobileOptionalPublication.test-fixtures.ts";
import { afterEach, expect, it } from "vitest";
import {
  revalidateMobileOptionalPublication,
  type VerifiedMobilePublication,
} from "./mobileOptionalPublication.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}
function gate() {
  let release!: () => void, entered!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { pause, ready, release, entered };
}

it("joins proof reads and refuses independent component IO before allocating", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    const hold = gate();
    let calls = 0;
    publicationWiring.before = async () => {
      if (++calls === 1) {
        hold.entered();
        await hold.pause;
      }
    };
    const read = revalidateMobileOptionalPublication(proof);
    await hold.ready;
    try {
      expect(revalidateMobileOptionalPublication(proof)).toBe(read);
      expect(() => publisher.remint(f.request.stageId, 1)).toThrow(/budget/);
      await expect(
        revalidateMobileOptionalPublication(proof, new AbortController().signal),
      ).rejects.toThrow(/budget/);
    } finally {
      hold.release();
    }
    expect((await read).stageId).toBe(f.request.stageId);
  });
});

it("settles an abandoned signal-less read before releasing the owner and stops later reads", async () => {
  const f = await fixture(),
    hold = gate();
  let proof!: VerifiedMobilePublication;
  let accepted!: Promise<unknown>;
  let calls = 0,
    released = false,
    finished = false;
  const outcome = f
    .run(
      async (publisher) => {
        proof = await publisher.publish(f.request);
        publicationWiring.before = async () => {
          if (++calls === 1) {
            hold.entered();
            await hold.pause;
          }
        };
        accepted = revalidateMobileOptionalPublication(proof);
        await hold.ready;
        return "callback ended while accepted IO is paused";
      },
      {
        onExit: async () => {
          released = true;
        },
      },
    )
    .then(() => {
      finished = true;
    });
  await hold.ready;
  await new Promise((resolve) => setImmediate(resolve));
  expect(released).toBe(false);
  expect(finished).toBe(false);
  await f.owner().assertHeld();
  hold.release();
  await outcome;
  await expect(accepted).rejects.toThrow();
  expect(calls).toBe(1);
  expect(released).toBe(true);
  await expect(revalidateMobileOptionalPublication(proof)).rejects.toThrow(/authority/);
});

it("rejects a persisted receipt redirected to a different directory key even with the same inode", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    await publisher.publish(f.request);
    const state = f.read();
    if (state.schemaVersion !== 3) throw new Error("fixture mobile journal absent");
    const stage = state.mobile.stages[0]!;
    const intent = stage.publicationIntent!;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const otherKey = "f".repeat(64);
    await fs.rename(
      path.join(f.control.root, "components-v1", intent.key),
      path.join(f.control.root, "components-v1", otherKey),
    );
    f.replaceState({
      ...state,
      mobile: {
        ...state.mobile,
        stages: [{ ...stage, publicationIntent: { ...intent, key: otherKey } }],
      },
    });
    await expect(publisher.remint(f.request.stageId, 1)).rejects.toThrow(/owner-computed/);
  });
});
