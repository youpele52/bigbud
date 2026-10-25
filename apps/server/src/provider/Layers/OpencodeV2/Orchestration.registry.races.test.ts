import { afterEach, expect, it, vi } from "vitest";
import { makeV2RegistryRaceFixture } from "./Orchestration.registry.races.fixture.ts";

afterEach(() => vi.restoreAllMocks());

it("atomic enroll commit cannot overrun the 32-owner Location bound after concurrent proof awaits", async () => {
  const fixture = await makeV2RegistryRaceFixture();
  try {
    for (let index = 0; index < 31; index++) {
      const owner = fixture.owner(index);
      await fixture.host.call("enroll", fixture.envelope(owner, "enroll", 1, Date.now() + 55000));
    }
    let release!: () => void,
      entered = 0;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.holdProof(async () => {
      entered++;
      await barrier;
    });
    const first = fixture.owner(31),
      second = fixture.owner(32);
    const calls = [
      fixture.host.call("enroll", fixture.envelope(first, "enroll", 1, Date.now() + 55000)),
      fixture.host.call("enroll", fixture.envelope(second, "enroll", 1, Date.now() + 55000)),
    ];
    const settled = Promise.allSettled(calls);
    await expect.poll(() => entered).toBe(2);
    release();
    expect((await settled).filter((result) => result.status === "fulfilled")).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

it("capacity pressure does not forget an installed required boundary for detached native history", async () => {
  const fixture = await makeV2RegistryRaceFixture();
  try {
    const original = fixture.owner(0);
    await fixture.host.call("enroll", fixture.envelope(original, "enroll", 1, Date.now() + 55000));
    await fixture.host.call("detach", fixture.envelope(original, "detach"));
    for (let index = 1; index <= 32; index++) {
      const owner = fixture.owner(index);
      await fixture.host
        .call("enroll", fixture.envelope(owner, "enroll", 1, Date.now() + 55000))
        .catch(() => {});
    }
    await expect(fixture.host.request(original.nativeSessionId)).rejects.toThrow("Required");
  } finally {
    await fixture.close();
  }
});

it("a delayed active callback cannot expose tools after its acknowledged lease expired", async () => {
  const fixture = await makeV2RegistryRaceFixture();
  const start = Date.now();
  let now = start;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const owner = fixture.owner(0);
    await fixture.host.call("enroll", fixture.envelope(owner, "enroll", 1, start + 55000));
    fixture.holdStatus(async () => {
      now = start + 55001;
    });
    await expect(fixture.host.request(owner.nativeSessionId)).rejects.toThrow("Required");
  } finally {
    await fixture.close();
  }
});

it("the five-second enrollment proof deadline covers native metadata reads and releases pending slots", async () => {
  const fixture = await makeV2RegistryRaceFixture();
  try {
    fixture.host.context.session.get = async () => new Promise(() => {});
    const owner = fixture.owner(0);
    const operation = fixture.host.call(
      "enroll",
      fixture.envelope(owner, "enroll", 1, Date.now() + 55000),
    );
    const outcome = await Promise.race([
      operation.then(
        () => "accepted",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 5500)),
    ]);
    expect(outcome).toBe("rejected");
    expect(await fixture.host.call("inspect", fixture.envelope(owner, "inspect"))).toMatchObject({
      state: "missing",
    });
  } finally {
    await fixture.close();
  }
}, 10000);
