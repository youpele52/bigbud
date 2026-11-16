import { describe, expect, it } from "vitest";
import {
  MOBILE_HOST_DIRECTORY_STORAGE_KEY,
  readMobileHostDirectory,
  writeMobileHostDirectory,
} from "./mobileHostDirectory";
import { mobileHostNavigationURL } from "../logic/mobileDeploymentPolicy";
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}
describe("credential-free per-origin host directory", () => {
  it("stores only a chosen HTTPS link/public authority, with a clean top-level destination", () => {
    const target = storage();
    const entry = {
      backendOrigin: "https://b.invalid",
      displayName: "VPS",
      authorityId: "b".repeat(32),
    };
    expect(writeMobileHostDirectory(target, [entry])).toBe(true);
    expect(readMobileHostDirectory(target)).toEqual({ ok: true, entries: [entry] });
    expect(mobileHostNavigationURL(entry.backendOrigin)).toBe("https://b.invalid/mobile/");
    expect(target.data.get(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).not.toMatch(
      /token|secret|session|draft/i,
    );
  });
  it.each(["sessionToken", "secret", "draft", "sessionId", "websocketUrl"])(
    "refuses credential/private field %s rather than copying it",
    (field) => {
      const target = storage();
      const value = { backendOrigin: "https://b.invalid", [field]: "fixture-private" };
      expect(writeMobileHostDirectory(target, [value])).toBe(false);
      expect(target.data.has(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBe(false);
    },
  );
  it("preserves preexisting malformed/secret-bearing raw data without repairing or overwriting it", () => {
    const target = storage();
    const raw = JSON.stringify({
      version: 1,
      entries: [{ backendOrigin: "https://b.invalid", sessionToken: "fixture-private" }],
    });
    target.data.set(MOBILE_HOST_DIRECTORY_STORAGE_KEY, raw);
    expect(readMobileHostDirectory(target)).toEqual({ ok: false });
    expect(writeMobileHostDirectory(target, [{ backendOrigin: "https://a.invalid" }])).toBe(false);
    expect(target.data.get(MOBILE_HOST_DIRECTORY_STORAGE_KEY)).toBe(raw);
  });
  it("rejects non-HTTPS, duplicate, credential-bearing and malformed public identities", () => {
    for (const entry of [
      { backendOrigin: "http://b.invalid" },
      { backendOrigin: "https://user:password@b.invalid" },
      { backendOrigin: "https://b.invalid?secret=fixture" },
      { backendOrigin: "https://b.invalid", authorityId: "not-an-authority" },
    ]) {
      expect(writeMobileHostDirectory(storage(), [entry])).toBe(false);
    }
    expect(
      writeMobileHostDirectory(storage(), [
        { backendOrigin: "https://a.invalid" },
        { backendOrigin: "https://a.invalid" },
      ]),
    ).toBe(false);
  });
  it("bounds links to32 and reports denied writes without losing the original directory", () => {
    const target = storage();
    const entries = Array.from({ length: 32 }, (_, i) => ({
      backendOrigin: `https://host-${i}.invalid`,
    }));
    expect(writeMobileHostDirectory(target, entries)).toBe(true);
    expect(
      writeMobileHostDirectory(target, [...entries, { backendOrigin: "https://overflow.invalid" }]),
    ).toBe(false);
    expect(
      writeMobileHostDirectory(
        {
          ...target,
          setItem: () => {
            throw new Error("denied");
          },
        },
        [],
      ),
    ).toBe(false);
    expect(readMobileHostDirectory(target)).toEqual({ ok: true, entries });
  });
});
