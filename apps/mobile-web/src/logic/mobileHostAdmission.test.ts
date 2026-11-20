import { describe, expect, it, vi } from "vitest";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";

import { assessMobileHostDescriptor, fetchMobileHostDescriptor } from "./mobileHostAdmission";

const descriptor: RemoteBackendMobileDescriptor = {
  handshakeRevision: 1,
  authority: {
    authorityId: "a".repeat(32),
    keyFingerprint: `sha256:${"b".repeat(64)}`,
    keyEpoch: 1,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "fixture",
  mobileRpcRevision: 1,
  mobileCapable: true,
};
const origin = "https://fixture.invalid";
const response = (value: unknown) => new Response(JSON.stringify(value));

describe("public HTTPS mobile host admission", () => {
  it("reads the real narrow endpoint without credentials, referrers or redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...descriptor, privateField: "stripped" }));
    expect(await fetchMobileHostDescriptor(origin, { fetch: fetcher })).toEqual({
      status: "descriptor",
      descriptor,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${origin}/api/mobile/handshake`, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    "http://fixture.invalid",
    "https://user:secret@fixture.invalid",
    `${origin}/path`,
    `${origin}?token=secret`,
  ])(
    "refuses noncanonical or non-HTTPS identity origins before any request: %s",
    async (invalid) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(fetchMobileHostDescriptor(invalid, { fetch: fetcher })).rejects.toThrow(
        "exact HTTPS origin",
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("distinguishes a genuinely missing legacy route from unavailable identity service", async () => {
    expect(
      await fetchMobileHostDescriptor(origin, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
      }),
    ).toEqual({ status: "legacy" });
    await expect(
      fetchMobileHostDescriptor(origin, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
      }),
    ).rejects.toThrow("Could not verify");
  });

  it("rejects redirected responses even when a fetch implementation ignores redirect:error", async () => {
    const redirected = response(descriptor);
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(
      fetchMobileHostDescriptor(origin, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(redirected),
      }),
    ).rejects.toThrow("cannot follow");
  });

  it("rejects malformed and oversized descriptors without admitting a session", async () => {
    await expect(
      fetchMobileHostDescriptor(origin, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(response({})),
      }),
    ).rejects.toThrow();
    await expect(
      fetchMobileHostDescriptor(origin, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(16385))),
      }),
    ).rejects.toThrow("too large");
  });

  it("never echoes malformed descriptor payloads in user-facing errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("fixture-sensitive-payload"));
    let caught: unknown;
    try {
      await fetchMobileHostDescriptor(origin, { fetch: fetcher });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "Backend identity response is invalid. Retry or update this host.",
    );
    expect((caught as Error).cause).toBeUndefined();
  });

  it("requires explicit first-seen confirmation, compatible revisions and actual mobile readiness", () => {
    expect(assessMobileHostDescriptor(descriptor, null, false).reason).toBe(
      "confirmation-required",
    );
    expect(assessMobileHostDescriptor(descriptor, null, true).allowed).toBe(true);
    expect(
      assessMobileHostDescriptor({ ...descriptor, mobileCapable: false }, null, true).reason,
    ).toBe("mobile-unavailable");
    expect(
      assessMobileHostDescriptor({ ...descriptor, mobileRpcRevision: 999 }, null, true).reason,
    ).toBe("unsupported-revision");
  });

  it("does not let first-seen confirmation override a changed pinned authority or key", () => {
    expect(assessMobileHostDescriptor(descriptor, descriptor, false).allowed).toBe(true);
    expect(
      assessMobileHostDescriptor(
        { ...descriptor, authority: { ...descriptor.authority, authorityId: "d".repeat(32) } },
        descriptor,
        true,
      ).reason,
    ).toBe("authority-changed");
    expect(
      assessMobileHostDescriptor(
        {
          ...descriptor,
          authority: {
            ...descriptor.authority,
            keyEpoch: 2,
            keyFingerprint: `sha256:${"e".repeat(64)}`,
          },
        },
        descriptor,
        true,
      ).reason,
    ).toBe("key-rotated");
  });
});
