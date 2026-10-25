import { writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { discoverV2SharedService, readV2SharedServiceJson } from "./SharedService.discovery.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import {
  sharedServiceTestContract,
  sharedServiceTestRegistration,
} from "./SharedService.test.fixture.ts";
import {
  assertV2SharedQualifiedVersion,
  isV2SharedUpdateRecommended,
} from "./SharedService.compatibility.ts";

it("borrows a qualified older service with two bounded authenticated GETs only", async () => {
  const fixture = await sharedServiceTestRegistration();
  const request = vi.fn(async (url: URL, init: RequestInit) => {
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("opencode:private-fixture-password").toString("base64")}`,
    );
    return Response.json(
      url.pathname === "/api/info" ? { version: "2.0.24", pid: 42 } : sharedServiceTestContract(),
    );
  });
  try {
    const result = await discoverV2SharedService({
      file: fixture.file,
      fetch: request as unknown as typeof fetch,
    });
    expect(result.version).toBe("2.0.24");
    expect(result.generation).not.toContain(fixture.value.password);
    expect(request.mock.calls.map(([url]) => url.pathname)).toEqual(["/api/info", "/openapi.json"]);
  } finally {
    await fixture.close();
  }
});

it.each(["1.0.0", "3.0.0", "2.00.24", "2.0.24-beta", "2.0.9007199254740992"])(
  "rejects unsupported %s",
  (version) => {
    expect(() => assertV2SharedQualifiedVersion(version)).toThrow("unsupported");
  },
);

it("rejects an older stable V2 with missing APIs, not its patch number, without mutation or credential reads", async () => {
  const fixture = await sharedServiceTestRegistration({ version: "2.0.23" });
  const request = vi.fn(async (url: URL) =>
    Response.json(url.pathname === "/api/info" ? { version: "2.0.23", pid: 42 } : {}),
  );
  try {
    await expect(
      discoverV2SharedService({ file: fixture.file, fetch: request as unknown as typeof fetch }),
    ).rejects.toThrow("invalid or incomplete API contract");
    expect(request.mock.calls.map(([url]) => url.pathname)).toEqual(["/api/info", "/openapi.json"]);
  } finally {
    await fixture.close();
  }
});

it("recommends an update only below the supported client version", () => {
  for (const older of ["2.0.24", "2.0.29", "2.0.99", "2.1.3"])
    expect(isV2SharedUpdateRecommended(older)).toBe(true);
  for (const current of ["2.1.4", "2.1.5", "2.1.10", "2.2.0", "2.999.0"])
    expect(isV2SharedUpdateRecommended(current)).toBe(false);
});

it.each([
  "2.0.0",
  "2.0.20",
  "2.0.24",
  "2.0.25",
  "2.0.26",
  "2.0.27",
  "2.0.28",
  "2.1.0",
  "2.999.999",
])("accepts %s only after the required API contract passes", async (version) => {
  const fixture = await sharedServiceTestRegistration({ version });
  const request = vi.fn(async (url: URL) =>
    Response.json(
      url.pathname === "/api/info" ? { version, pid: 42 } : sharedServiceTestContract(),
    ),
  );
  try {
    expect(
      (
        await discoverV2SharedService({
          file: fixture.file,
          fetch: request as unknown as typeof fetch,
        })
      ).version,
    ).toBe(version);
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    await fixture.close();
  }
});

it.each([
  "pid",
  "version",
  "missing-route",
  "replacement",
  "invalid-json",
  "oversized",
  "http-failure",
])("rejects %s without mutations or native error leakage", async (scenario) => {
  const fixture = await sharedServiceTestRegistration();
  const request = vi.fn(async (url: URL) => {
    if (scenario === "http-failure") return new Response("secret native response", { status: 500 });
    if (scenario === "invalid-json") return new Response("secret native response");
    if (scenario === "oversized") return new Response("x".repeat(2 * 1024 * 1024 + 1));
    if (url.pathname === "/api/info")
      return Response.json({
        version: scenario === "version" ? "2.0.26" : "2.0.24",
        pid: scenario === "pid" ? 43 : 42,
      });
    const contract = sharedServiceTestContract();
    if (scenario === "missing-route") delete contract.paths["/api/session/{sessionID}/prompt"];
    if (scenario === "replacement")
      await writeFile(fixture.file, JSON.stringify({ ...fixture.value, id: "successor" }));
    return Response.json(contract);
  });
  try {
    const error = await discoverV2SharedService({
      file: fixture.file,
      fetch: request as unknown as typeof fetch,
    }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(
      /secret native response|private-fixture-password|admission may be unconfirmed/,
    );
    expect(
      request.mock.calls.every(([url]) => ["/api/info", "/openapi.json"].includes(url.pathname)),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

it("honors native endpoint usernames rather than hardcoding another profile's auth", async () => {
  const fixture = await sharedServiceTestRegistration();
  try {
    const registered = await readV2SharedRegistration(fixture.file);
    const request = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("native-user:private-fixture-password").toString("base64")}`,
      );
      return Response.json({ version: "2.0.24", pid: 42 });
    });
    await readV2SharedServiceJson(
      {
        ...registered,
        endpoint: {
          ...registered.endpoint,
          auth: { type: "basic", username: "native-user", password: fixture.value.password },
        },
      },
      "/api/info",
      { fetch: request as unknown as typeof fetch },
    );
  } finally {
    await fixture.close();
  }
});

it("rejects an unsafe registration before any authenticated request", async () => {
  const fixture = await sharedServiceTestRegistration({ url: "http://example.com:4096" });
  const request = vi.fn();
  try {
    await expect(
      discoverV2SharedService({ file: fixture.file, fetch: request as unknown as typeof fetch }),
    ).rejects.toThrow("registration is invalid");
    expect(request).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});
