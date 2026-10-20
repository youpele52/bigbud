import { expect, it, vi } from "vitest";
import { makeV2RegistryRaceFixture } from "./Orchestration.registry.races.fixture.ts";

it.each([true, "compact"] as const)(
  "reuses active capacity beyond 32 histories without forgetting detached or expired sessions, including after reload (%s)",
  async (namespace) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await makeV2RegistryRaceFixture();
    try {
      const sessions: string[] = [];
      for (let index = 0; index < 40; index++) {
        const owner = f.owner(index, namespace);
        sessions.push(owner.nativeSessionId);
        await expect(
          f.host.call("enroll", f.envelope(owner, "enroll", 1, Date.now() + 50000)),
        ).resolves.toMatchObject({ state: "active" });
        await f.host.call("detach", f.envelope(owner, "detach"));
      }
      const expired = f.owner(40, namespace);
      await f.host.call("enroll", f.envelope(expired, "enroll", 1, Date.now() + 1000));
      vi.setSystemTime(Date.now() + 2000);
      await expect(f.host.request(expired.nativeSessionId)).rejects.toThrow();
      // Evicted owner records and a completely new plugin instance must not reopen native work.
      for (const id of sessions) await expect(f.host.request(id)).rejects.toThrow();
      await f.restart();
      for (const id of [...sessions, expired.nativeSessionId])
        await expect(f.host.request(id)).rejects.toThrow();
      const next = f.owner(41, namespace);
      await expect(
        f.host.call("enroll", f.envelope(next, "enroll", 1, Date.now() + 50000)),
      ).resolves.toMatchObject({ state: "active" });
      expect(Object.keys((await f.host.request(next.nativeSessionId)).tools)).toHaveLength(5);
      expect(Object.keys((await f.host.request("unrelated-native-session")).tools)).toHaveLength(0);
      expect(
        Object.keys(
          (await f.host.request(`ses_bigbud_v2_${"f".repeat(64)}_${"0".repeat(64)}`)).tools,
        ),
      ).toHaveLength(0);
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  },
);

it("still bounds simultaneously active namespaced owners at 32", async () => {
  const f = await makeV2RegistryRaceFixture();
  try {
    const owners = Array.from({ length: 33 }, (_, index) => f.owner(index, true));
    for (const owner of owners.slice(0, 32))
      await f.host.call("enroll", f.envelope(owner, "enroll", 1, Date.now() + 50000));
    const last = owners[32]!;
    await expect(
      f.host.call("enroll", f.envelope(last, "enroll", 1, Date.now() + 50000)),
    ).rejects.toThrow();
    await f.host.call("detach", f.envelope(owners[0]!, "detach"));
    await expect(
      f.host.call("enroll", f.envelope(last, "enroll", 1, Date.now() + 50000)),
    ).resolves.toMatchObject({ state: "active" });
    await expect(f.host.request(owners[0]!.nativeSessionId)).rejects.toThrow();
  } finally {
    await f.close();
  }
});
