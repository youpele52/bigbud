import { expect, it, vi } from "vitest";
import {
  makeV2PublicCatalogLoader,
  mergeV2Catalogs,
  normalizeV2PublicCatalog,
  V2_PUBLIC_CATALOG_URL,
} from "./Catalog.public.ts";

const source = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      coder: { id: "coder", name: "Friendly Coder", experimental: { modes: { fast: {} } } },
      retired: { id: "retired", name: "Retired", status: "deprecated" },
      audio: { id: "audio", name: "Audio", modalities: { input: ["audio"], output: ["audio"] } },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: { coder: { id: "coder", name: "Other Coder" } },
  },
};
const fetchResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

it("discovers the full public text catalog with exact identities, friendly groups and no invented native capabilities", () => {
  const models = normalizeV2PublicCatalog(source);
  expect(models.map(({ slug, subProviderID, group }) => [slug, subProviderID, group])).toEqual([
    ["coder", "openai", "OpenAI"],
    ["coder-fast", "openai", "OpenAI"],
    ["coder", "anthropic", "Anthropic"],
  ]);
  expect(
    models.every((model) => model.availability === "requires-setup" && model.capabilities === null),
  ).toBe(true);
});

it("deduplicates published mode entries and excludes retired V1 provider aliases", () => {
  const models = normalizeV2PublicCatalog({
    openai: {
      ...source.openai,
      models: { ...source.openai.models, fast: { id: "coder-fast", name: "Explicit Fast" } },
    },
    "azure-cognitive-services": { ...source.openai, id: "azure-cognitive-services" },
  });
  expect(models).toHaveLength(2);
  expect(models.find(({ slug }) => slug === "coder-fast")?.name).toBe("Explicit Fast");
});

it("native inventory wins while missing/disabled public models remain setup-only, never availability proof", () => {
  const publicModels = normalizeV2PublicCatalog(source);
  const native = {
    ...publicModels[0]!,
    name: "Configured alias",
    availability: "available" as const,
    capabilities: {
      reasoningEffortLevels: [{ value: "native-only", label: "native-only" }],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  };
  const models = mergeV2Catalogs(
    publicModels,
    [native, { ...native, slug: "custom", subProviderID: "company", group: "Company Gateway" }],
    new Map([
      ["openai", "Configured Gateway"],
      ["company", "Company Gateway"],
    ]),
  );
  expect(
    models.find(({ slug, subProviderID }) => slug === native.slug && subProviderID === "openai"),
  ).toEqual(native);
  expect(models.find(({ slug }) => slug === "coder-fast")).toMatchObject({
    group: "Configured Gateway",
    availability: "requires-setup",
    capabilities: null,
  });
  expect(models.find(({ subProviderID }) => subProviderID === "anthropic")?.availability).toBe(
    "requires-setup",
  );
  expect(models.find(({ subProviderID }) => subProviderID === "company")?.slug).toBe("custom");
});

it("rejects malformed, duplicate and oversized inventories atomically", () => {
  expect(() => normalizeV2PublicCatalog({ broken: { id: "broken" } })).toThrow();
  expect(() =>
    normalizeV2PublicCatalog({
      openai: {
        ...source.openai,
        models: {
          one: { id: "same", name: "One" },
          two: { id: "same", name: "Two" },
        },
      },
    }),
  ).toThrow();
  expect(() =>
    normalizeV2PublicCatalog({
      openai: {
        ...source.openai,
        models: Object.fromEntries(
          Array.from({ length: 10_001 }, (_, i) => [String(i), { id: String(i), name: String(i) }]),
        ),
      },
    }),
  ).toThrow();
});

it("uses single-flight, TTL, bounded retry and last-good cache without credentials", async () => {
  let time = 1;
  const fetchCatalog = vi.fn().mockImplementation(async () => fetchResponse(source));
  const load = makeV2PublicCatalogLoader(fetchCatalog as unknown as typeof fetch, () => time);
  const [first, concurrent] = await Promise.all([load(), load()]);
  expect(concurrent).toEqual(first);
  expect(fetchCatalog).toHaveBeenCalledTimes(1);
  expect(fetchCatalog).toHaveBeenCalledWith(
    V2_PUBLIC_CATALOG_URL,
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: { accept: "application/json" },
    }),
  );
  await load();
  expect(fetchCatalog).toHaveBeenCalledTimes(1);
  time += 3_600_001;
  fetchCatalog.mockRejectedValue(new Error("secret details never propagated"));
  expect(await load()).toEqual({ models: first.models, stale: true });
  await load();
  expect(fetchCatalog).toHaveBeenCalledTimes(2);
  time += 30_001;
  fetchCatalog.mockResolvedValue(fetchResponse(source));
  expect((await load()).stale).toBe(false);
  expect(fetchCatalog).toHaveBeenCalledTimes(3);
});

it("fails closed on cold HTTP errors, malformed catalog and oversized streams without caching partial rows", async () => {
  for (const response of [
    new Response(null, { status: 503 }),
    fetchResponse({ bad: {} }),
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 129; i++) controller.enqueue(new Uint8Array(65536));
          controller.close();
        },
      }),
    ),
  ]) {
    const load = makeV2PublicCatalogLoader(vi.fn(async () => response) as unknown as typeof fetch);
    expect(await load()).toEqual({ models: [], stale: true });
  }
});
