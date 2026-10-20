import { expect, it } from "vitest";
import { makeV2AuxiliaryTextGenerator } from "./TextGeneration.native.ts";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "./TextGeneration.fixture.ts";
import { makeV2BoundedRouterFixture } from "./Runtime.router.fixture.ts";

it("round-trips auxiliary create/get/generate/delete through real loopback HTTP and the 100-char path router", async () => {
  const fixture = makeTextGenerationHttpFixture();
  const http = await makeV2BoundedRouterFixture(fixture);
  const native = makeV2AuxiliaryTextGenerator({
    connect: async () => ({
      client: http.client,
      storageIdentity: "http-storage",
      descriptor: {
        storageIdentity: "http-storage",
        registrationFile: "/synthetic/service.json",
        generation: "synthetic-generation",
      },
      close: async () => {},
    }),
  });
  try {
    expect(
      await native({
        directory: "/fixture",
        operation: "generateThreadTitle",
        prompt: "Metadata only",
        selection: textGenerationSelection,
        signal: new AbortController().signal,
      }),
    ).toBe(fixture.options.text);
    const creation = fixture.requests.find(
      ({ pathname, method }) => pathname === "/api/session" && method === "POST",
    )!;
    expect(creation.body.id).toHaveLength(96);
    expect(fixture.requests.filter(({ pathname }) => pathname.endsWith("/generate"))).toHaveLength(
      1,
    );
    expect(fixture.sessions.size).toBe(0);
  } finally {
    await http.close();
  }
});
