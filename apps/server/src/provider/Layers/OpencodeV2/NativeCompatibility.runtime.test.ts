import { expect, it, vi } from "vitest";
import { makeOwnedClient } from "./Client.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { bindV2NativeCompatibility } from "./NativeCompatibility.binding.ts";
import { verifyV2NativeEligibility } from "./NativeCompatibility.runtime.ts";
import { sharedServiceTestRegistration } from "./SharedService.test.fixture.ts";
import { v2SharedGeneration, readV2SharedRegistration } from "./SharedService.registration.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { v2CanonicalApiFixture } from "./NativeCompatibility.api.fixture.ts";

it.each(["health-mismatch", "missing-canonical-api"])(
  "production eligibility remains read-only and specifically blocks %s while model catalog is independent",
  async (scenario) => {
    const registration = await sharedServiceTestRegistration({ version: "2.0.28" }),
      app = await makeV2ThreadPluginFixture(),
      permit = {
        revision: 1,
        signal: new AbortController().signal,
        assertCurrent: () => {},
        release: () => {},
      };
    const calls: string[] = [],
      contract = v2CanonicalApiFixture();
    if (scenario === "missing-canonical-api") delete contract.paths["/api/config"];
    const fetch = Object.assign(
      vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const route = new URL(String(input)).pathname;
        calls.push(`${init?.method ?? "GET"} ${route}`);
        const value =
          route === "/api/info"
            ? {
                version: scenario === "health-mismatch" ? "2.0.26" : "2.0.28",
                pid: registration.value.pid,
              }
            : route === "/openapi.json"
              ? contract
              : route === "/api/model"
                ? {
                    location: { directory: "/fixture/location" },
                    data: [{ id: "synthetic", providerID: "synthetic" }],
                  }
                : {};
        return new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        });
      }),
      { preconnect: () => {} },
    ) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("fetch", fetch);
    try {
      const native = await readV2SharedRegistration(registration.file),
        client = makeOwnedClient({
          endpoint: native.endpoint.url,
          password: native.endpoint.auth!.password,
          fetch,
        });
      bindV2NativeCompatibility(client, {
        descriptor: {
          registrationFile: registration.file,
          generation: v2SharedGeneration(native),
          storageIdentity: "synthetic-only",
        },
        assertCurrent: () => {},
      });
      await runV2RequestContext(
        { transport: registration.file, permit, intent: "execute" },
        async () => {
          await expect(
            verifyV2NativeEligibility(app.artifact, client, "/fixture/location", "/fixture/global"),
          ).rejects.toMatchObject({
            reasonCode:
              scenario === "health-mismatch"
                ? "native-generation-changed"
                : "native-contract-incompatible",
          });
          expect(
            (await client.model.list({ location: { directory: "/fixture/location" } })).data,
          ).toHaveLength(1);
        },
      );
      expect(
        calls.every((call) =>
          ["GET /api/info", "GET /openapi.json", "GET /api/model"].includes(call),
        ),
      ).toBe(true);
      expect(calls.some((call) => /config|plugin|rpc|session|shell/.test(call))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      await registration.close();
    }
  },
);
