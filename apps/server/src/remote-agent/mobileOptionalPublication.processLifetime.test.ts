import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import { afterEach, expect, it } from "vitest";
import {
  withMobilePublicationLifetime,
  withMobilePublicationTeardown,
} from "./mobileGatewayLifecycle.publication.ts";
import { revalidateMobileOptionalPublication } from "./mobileOptionalPublication.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}
it("tracks an abandoned lifetime, permits nested owned reads, and settles finally teardown before lock release", async () => {
  const f = await fixture();
  let entered!: () => void,
    release!: () => void,
    finished = false,
    released = false;
  const cleanupEntered = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const outcome = f.run(
    async (publisher) => {
      const proof = await publisher.publish(f.request);
      let started!: () => void;
      const running = new Promise<void>((r) => {
        started = r;
      });
      const job = withMobilePublicationLifetime(proof, async (signal) => {
        await revalidateMobileOptionalPublication(proof);
        started();
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        } finally {
          await withMobilePublicationTeardown(proof, async (authority) => {
            await authority.owner.assertHeld();
            entered();
            await gate;
            await authority.owner.assertHeld();
            finished = true;
          });
        }
      });
      await running;
      await expect(
        withMobilePublicationLifetime(proof, async () => "must not start another child"),
      ).rejects.toThrow(/already owns/);
      void job.catch(() => {});
      return "callback did not await process";
    },
    {
      onExit: async () => {
        expect(finished).toBe(true);
        released = true;
      },
    },
  );
  await cleanupEntered;
  expect(finished).toBe(false);
  expect(released).toBe(false);
  await f.owner().assertHeld();
  await expect(f.run(async () => "second lease")).rejects.toThrow(/lease/);
  release();
  expect(await outcome).toBe("callback did not await process");
  expect(released).toBe(true);
});
