import {
  publicationFixture,
  publicationWiring,
} from "./mobileOptionalPublication.test-fixtures.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { revalidateMobileOptionalPublication } from "./mobileOptionalPublication.ts";
import { setRemoteAgentMobileConsent } from "./remoteAgentInstall.mobile.transitions.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}

it("durably publishes signed raw files through current owner and same CAS, without readiness", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    const verified = await revalidateMobileOptionalPublication(proof);
    expect(await fs.readFile(verified.gatewayPath)).toEqual(f.request.gatewayBytes);
    expect(await fs.readFile(verified.assetsArchivePath)).toEqual(f.request.assetsBytes);
    const state = f.read();
    expect(state.schemaVersion === 3 && state.mobile.stages[0]?.phase).toBe("files-published");
    expect(state.builds).toHaveLength(1);
    expect(state.slotReservations).toEqual([]);
    expect(Object.keys(proof)).toEqual([]);
    await expect(
      revalidateMobileOptionalPublication(JSON.parse(JSON.stringify(proof))),
    ).rejects.toThrow(/opaque/);
  });
});

it("joins same-stage work and retries without replacing published inodes", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const first = publisher.publish(f.request);
    expect(publisher.publish(f.request)).toBe(first);
    const proof = await first;
    const before = await revalidateMobileOptionalPublication(proof);
    const inode = (await fs.lstat(before.gatewayPath)).ino;
    const revision = f.read().revision;
    const again = await publisher.publish(f.request);
    const after = await revalidateMobileOptionalPublication(again);
    expect((await fs.lstat(after.gatewayPath)).ino).toBe(inode);
    expect(f.read().revision).toBe(revision);
  });
});

it("requires actual current settings consent before optional file creation", async () => {
  const f = await fixture();
  await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }));
  await expect(f.run((publisher) => publisher.publish(f.request))).rejects.toThrow();
  await expect(fs.lstat(join(f.control.root, "components-v1"))).rejects.toThrow();
});

it("revalidates actual lock, reservation and full authority rather than JSON context", async () => {
  const f = await fixture();
  await fs.unlink(join(f.control.root, "account-authority-v1"));
  await expect(f.run((publisher) => publisher.publish(f.request))).rejects.toThrow();
  await expect(fs.lstat(join(f.control.root, "components-v1"))).rejects.toThrow();
});

it("rejects namespace links without writing into their target", async () => {
  const f = await fixture();
  const outside = join(f.home, "foreign");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, join(f.control.root, "components-v1"));
  await expect(f.run((publisher) => publisher.publish(f.request))).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
});

it("invalidates proof on settings revocation, even if settings are enabled again", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }));
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: true } }));
    await expect(revalidateMobileOptionalPublication(proof)).rejects.toThrow(/authority/);
  });
});

it("fences a final publication after a competing revoke/re-enable CAS", async () => {
  const f = await fixture();
  let injected = false;
  publicationWiring.before = async (script) => {
    const encoded = script.match(
      /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 --decode > "\$next"/,
    )?.[1];
    if (
      !injected &&
      encoded &&
      Buffer.from(encoded, "base64").toString().includes('"phase":"files-published"')
    ) {
      injected = true;
      f.command().beforeNextCas((state) =>
        setRemoteAgentMobileConsent(
          setRemoteAgentMobileConsent(state, { owner: f.pin, expectedConsentRevision: 1 }, false),
          { owner: f.pin, expectedConsentRevision: 2 },
          true,
        ),
      );
    }
  };
  await expect(f.run((publisher) => publisher.publish(f.request))).rejects.toThrow();
  expect(injected).toBe(true);
  const state = f.read();
  expect(state.schemaVersion === 3 && state.mobile.stages[0]?.phase).toBe("cancelled");
  expect(state.schemaVersion === 3 && state.mobile.stages[0]?.publicationReceipt).toBeUndefined();
  expect(state.schemaVersion === 3 && state.mobile.stages[0]?.publicationIntent).toBeDefined();
});
