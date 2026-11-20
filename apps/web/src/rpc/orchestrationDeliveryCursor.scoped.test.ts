import { describe, expect, it } from "vitest";
import { createScopedDeliveryCursor } from "./orchestrationDeliveryCursor.scoped";

function storage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}
const pin = (authorityId: string, installationFingerprint = "install-a") => ({
  authority: { authorityId, keyEpoch: 1, keyFingerprint: "key-a" },
  installationFingerprint,
});

describe("backend delivery cursor isolation", () => {
  it("separates authorities/installations even with identical consumer ids and leaves legacy data alone", () => {
    const session = storage();
    const local = storage();
    local.setItem("bigbud:orchestration-delivery-cursor:same", "900");
    const config = { session, local, randomId: () => "same" };
    const a = createScopedDeliveryCursor(pin("a"), config);
    const b = createScopedDeliveryCursor(pin("b"), config);
    const copy = createScopedDeliveryCursor(pin("a", "install-copy"), config);
    a.write(12);
    b.write(3);
    expect([a.read(), b.read(), copy.read()]).toEqual([12, 3, 0]);
    expect(local.getItem("bigbud:orchestration-delivery-cursor:same")).toBe("900");
    expect(createScopedDeliveryCursor(pin("a"), config).read()).toBe(12);
    expect(
      createScopedDeliveryCursor(
        { ...pin("a"), authority: { ...pin("a").authority, keyEpoch: 2 } },
        config,
      ).read(),
    ).toBe(12);
  });

  it("rejects corrupt/unsafe sequences and keeps quota failures nonfatal", () => {
    const session = storage();
    const local = storage();
    const cursor = createScopedDeliveryCursor(pin("a"), { session, local, randomId: () => "id" });
    cursor.write(4);
    const key = [...local.entries.keys()][0]!;
    for (const value of ["-1", "1junk", "1.5", "9007199254740992", "NaN"]) {
      local.setItem(key, value);
      expect(cursor.read()).toBe(0);
    }
    cursor.write(7);
    for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) cursor.write(value);
    expect(cursor.read()).toBe(7);
    const unavailable = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const privateCursor = createScopedDeliveryCursor(pin("a"), {
      session: unavailable,
      local: unavailable,
      randomId: () => "ephemeral",
    });
    expect(privateCursor.consumerId).toBe("ephemeral");
    expect(privateCursor.read()).toBe(0);
    expect(() => privateCursor.write(10)).not.toThrow();
  });
});
