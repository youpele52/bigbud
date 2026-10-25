import { describe, expect, it } from "vitest";
import { V2TextGenerationUncertain } from "./TextGeneration.errors.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import {
  makeV2AuxiliaryTextGenerator,
  V2_TEXT_GENERATION_PERMISSIONS,
} from "./TextGeneration.native.ts";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "./TextGeneration.fixture.ts";

const request = (signal = new AbortController().signal) => ({
  directory: "/fixture",
  operation: "generateThreadTitle",
  prompt: "Bounded metadata only",
  selection: textGenerationSelection,
  signal,
});

describe("native V2 auxiliary generation", () => {
  it("rejects changed native provenance after generation instead of publishing misleading model truth", async () => {
    const fixture = makeTextGenerationHttpFixture();
    fixture.options.generate = async () => {
      fixture.options.corruptSession = true;
      return fixture.options.text;
    };
    await expect(makeV2AuxiliaryTextGenerator(fixture)(request())).rejects.toBeInstanceOf(
      V2TextGenerationUncertain,
    );
    expect(fixture.sessions.size).toBe(1);
    expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
  });
  it("fences revoked native trust while a transient generation is physically unsettled", async () => {
    const fixture = makeTextGenerationHttpFixture();
    let started!: () => void, finish!: (text: string) => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    fixture.options.generate = () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const revoked = new AbortController();
    const job = runV2RequestContext(
      {
        transport: "synthetic-only",
        intent: "execute",
        permit: {
          revision: 1,
          signal: revoked.signal,
          assertCurrent: () => revoked.signal.throwIfAborted(),
          release: () => {},
        },
      },
      () => makeV2AuxiliaryTextGenerator(fixture)(request()),
    );
    await entered;
    const rejected = expect(job).rejects.toThrow();
    revoked.abort();
    await rejected;
    finish("late output");
    expect(fixture.sessions.size).toBe(1);
    expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
  });
  it("uses compact separate sessions, exact native model/variant, denied tools and transient generation", async () => {
    const fixture = makeTextGenerationHttpFixture();
    const run = makeV2AuxiliaryTextGenerator(fixture);
    expect(await run(request())).toBe(fixture.options.text);
    const creation = fixture.requests.find(
      ({ pathname, method }) => pathname === "/api/session" && method === "POST",
    )!;
    expect(creation.body.id).toHaveLength(96);
    expect(creation.body).toMatchObject({
      model: { providerID: "exact-account", id: "exact-model", variant: "reasoning" },
      permissions: V2_TEXT_GENERATION_PERMISSIONS,
      metadata: { bigbud_workload: "text-generation", bigbud_storage: "verified-storage" },
    });
    expect(fixture.requests.filter(({ pathname }) => pathname.endsWith("/generate"))).toHaveLength(
      1,
    );
    expect(
      fixture.requests.some(({ pathname }) => /prompt|inbox|rpc|config|interrupt/.test(pathname)),
    ).toBe(false);
    expect(fixture.sessions.size).toBe(0);
    expect(fixture.options.closed).toBe(1);
  });
  it("runs independent jobs concurrently without service-wide idleness or touching other history", async () => {
    const fixture = makeTextGenerationHttpFixture();
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let both!: () => void;
    const entered = new Promise<void>((resolve) => {
      both = resolve;
    });
    fixture.options.generate = async () => {
      if (++started === 2) both();
      await block;
      return "result";
    };
    const run = makeV2AuxiliaryTextGenerator({ ...fixture, maxConcurrent: 2 });
    const jobs = [run(request()), run(request())];
    await entered;
    expect(fixture.sessions.size).toBe(2);
    await expect(run(request())).rejects.toThrow("capacity");
    release();
    expect(await Promise.all(jobs)).toEqual(["result", "result"]);
    expect(fixture.sessions.size).toBe(0);
  });
  it.each(["ownership", "transport", "delete"])(
    "retains %s uncertainty without replay or unknown cleanup",
    async (scenario) => {
      const fixture = makeTextGenerationHttpFixture();
      fixture.options.corruptSession = scenario === "ownership";
      fixture.options.failGenerate = scenario === "transport";
      fixture.options.failDelete = scenario === "delete";
      const run = makeV2AuxiliaryTextGenerator({ ...fixture, maxConcurrent: 1 });
      if (scenario === "delete") await run(request());
      else await expect(run(request())).rejects.toThrow();
      expect(fixture.sessions.size).toBe(1);
      const generate = fixture.requests.filter(({ pathname }) => pathname.endsWith("/generate"));
      expect(generate).toHaveLength(scenario === "ownership" ? 0 : 1);
      await expect(run(request())).rejects.toThrow("capacity");
      if (scenario !== "delete")
        expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
    },
  );
  it("rejects missing account, unavailable variants, wrong Location and pre-cancellation before paid work", async () => {
    const fixture = makeTextGenerationHttpFixture();
    const run = makeV2AuxiliaryTextGenerator(fixture);
    await expect(
      run({ ...request(), selection: { provider: "opencodeV2", model: "exact-model" } }),
    ).rejects.toThrow("explicit");
    await expect(
      run({
        ...request(),
        selection: { ...textGenerationSelection, options: { variant: "missing" } },
      }),
    ).rejects.toThrow("not currently available");
    await expect(run({ ...request(), directory: "/other" })).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(run(request(controller.signal))).rejects.toThrow();
    expect(fixture.requests.some(({ method }) => method === "POST")).toBe(false);
  });
  it("timeouts retain unresolved native work and capacity without deleting or replaying", async () => {
    const fixture = makeTextGenerationHttpFixture();
    let finish!: (text: string) => void;
    fixture.options.generate = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const run = makeV2AuxiliaryTextGenerator({ ...fixture, maxConcurrent: 1, timeoutMs: 20 });
    await expect(run(request())).rejects.toBeInstanceOf(V2TextGenerationUncertain);
    expect(fixture.sessions.size).toBe(1);
    await expect(run(request())).rejects.toThrow("capacity");
    finish("late");
    await Promise.resolve();
    expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
  });
});
