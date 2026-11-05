import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { decodeCatalog, isContributorModel } from "./Client.schema.ts";
import {
  discoverMuse,
  formatMuseModelDisplayName,
  isMusePlatformQualified,
  mapCatalogModel,
  musePlatformGateReason,
} from "./Provider.discovery.ts";
import {
  assertMuseHostQualified,
  museSandboxUnavailableMessage,
  type MuseTransport,
} from "./Client.ts";

const catalogFixture = {
  providerId: "meta",
  profileId: "tbh",
  source: "providerCatalog",
  models: [
    {
      modelId: "muse-spark-1.3",
      displayLabel: "muse-spark-1.3",
      providerId: "meta",
      profileId: "tbh",
      isDefault: false,
      isActive: false,
      description: null,
      contextLimit: 1007997,
      outputLimit: 128000,
      cost: null,
      releaseDate: "2026-09-02",
      variants: ["minimal", "low", "high"],
      defaultReasoningEffort: "high",
      futureField: "tolerated",
    },
    {
      modelId: "muse-spark-1.3-contributor",
      displayLabel: "muse-spark-1.3-contributor",
      providerId: "meta",
      profileId: "tbh",
      isDefault: true,
      isActive: false,
      description: "Discounted tokens: content may be used for product improvement.",
      contextLimit: 1007997,
      outputLimit: 128000,
      cost: null,
      releaseDate: "2026-09-02",
      variants: "unknown",
    },
  ],
};

function fakeTransport(overrides: Partial<MuseTransport> = {}): MuseTransport {
  let counter = 0;
  return {
    initializeResult: {
      grantedCapabilities: ["sessionMcp"],
      sessionDurability: "durable",
      serverVersion: "1.4.14",
    },
    mintCommandId: () => `cmd-${++counter}`,
    command: async () => ({}),
    request: async (method) => {
      if (method === "model/list") return catalogFixture;
      if (method === "account/read")
        return { state: "accountLogin", credentialRequired: true, label: "redacted@example.com" };
      if (method === "permissionProfile/list")
        return {
          profiles: [
            { profileId: ":ask-me", label: "Ask me", available: true, reviewerAuthority: "human" },
          ],
        };
      return {};
    },
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

describe("Muse wire decoding", () => {
  it("decodes the qualified catalog and tolerates additive fields", () => {
    const decoded = decodeCatalog(catalogFixture);
    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isSome(decoded)) expect(decoded.value.models).toHaveLength(2);
  });

  it("maps catalog efforts without fabricating them when native variants are unknown", () => {
    const decoded = decodeCatalog(catalogFixture);
    if (Option.isNone(decoded)) throw new Error("fixture must decode");
    const [known, unknown] = decoded.value.models.map(mapCatalogModel);
    expect(known?.capabilities?.reasoningEffortLevels.map((e) => e.value)).toEqual([
      "minimal",
      "low",
      "high",
    ]);
    expect(unknown?.capabilities?.reasoningEffortLevels).toEqual([]);
    expect(unknown?.capabilities?.effortMetadataStatus).toBe("unknown");
  });

  it("formats native model IDs as human display names while keeping slugs stable", () => {
    expect(formatMuseModelDisplayName("muse-spark-1.3")).toBe("Muse Spark 1.3");
    expect(formatMuseModelDisplayName("muse-spark-1.3-contributor")).toBe(
      "Muse Spark 1.3 Contributor",
    );
    expect(formatMuseModelDisplayName("muse-spark-1.2-contributor")).toBe(
      "Muse Spark 1.2 Contributor",
    );
    expect(formatMuseModelDisplayName("muse-wonder-1.0")).toBe("Muse Wonder");
    expect(formatMuseModelDisplayName("muse-wonder")).toBe("Muse Wonder");
    const decoded = decodeCatalog(catalogFixture);
    if (Option.isNone(decoded)) throw new Error("fixture must decode");
    const [spark, contributor] = decoded.value.models.map(mapCatalogModel);
    expect(spark).toMatchObject({ slug: "muse-spark-1.3", name: "Muse Spark 1.3" });
    expect(contributor).toMatchObject({
      slug: "muse-spark-1.3-contributor",
      name: "Muse Spark 1.3 Contributor",
    });
  });

  it("flags contributor (training) models and never the catalog default silently", () => {
    expect(isContributorModel("muse-spark-1.3-contributor")).toBe(true);
    expect(isContributorModel("muse-spark-1.3")).toBe(false);
    const decoded = decodeCatalog(catalogFixture);
    if (Option.isNone(decoded)) throw new Error("fixture must decode");
    const contributor = decoded.value.models.map(mapCatalogModel)[1];
    expect(contributor?.contributorTraining).toBe(true);
    expect(contributor?.slug).toBe("muse-spark-1.3-contributor");
  });
});

describe("Muse discovery gates", () => {
  it("requires the sessionMcp grant and durable storage", () => {
    expect(assertMuseHostQualified(fakeTransport())).toBeUndefined();
    expect(
      assertMuseHostQualified(
        fakeTransport({
          initializeResult: { grantedCapabilities: [], sessionDurability: "durable" },
        }),
      ),
    ).toContain("sessionMcp");
    expect(
      assertMuseHostQualified(
        fakeTransport({
          initializeResult: { grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral" },
        }),
      ),
    ).toContain("durable");
  });

  it("discovers models and browser-login auth without surfacing the account label", async () => {
    const result = await discoverMuse(fakeTransport());
    expect(result.authStatus).toBe("authenticated");
    expect(result.authType).toBe("accountLogin");
    expect(result.models.map((m) => m.slug)).toEqual([
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
    ]);
    expect(JSON.stringify(result)).not.toContain("redacted@example.com");
  });

  it("rejects a non-meta catalog", async () => {
    const result = await discoverMuse(
      fakeTransport({
        request: async (method) =>
          method === "model/list" ? { providerId: "other", models: [] } : {},
      }),
    );
    expect(result.gateFailure).toContain("not the qualified Meta catalog");
  });

  it("enables macOS, Windows and Linux by default and keeps unknown platforms off", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(isMusePlatformQualified(platform)).toBe(true);
      expect(musePlatformGateReason(platform)).toBeUndefined();
    }
    expect(isMusePlatformQualified("freebsd" as NodeJS.Platform)).toBe(false);
    expect(musePlatformGateReason("freebsd" as NodeJS.Platform)).toContain("freebsd");
  });

  it("can still withdraw a single platform without affecting the others", () => {
    const withdrawn = { macos: true, windows: false, linux: true };
    expect(musePlatformGateReason("win32", withdrawn)).toContain("Windows");
    expect(musePlatformGateReason("darwin", withdrawn)).toBeUndefined();
    expect(musePlatformGateReason("linux", withdrawn)).toBeUndefined();
  });

  it("refuses a host that cannot enforce its sandbox, with a reason-specific remedy", () => {
    const base = fakeTransport();
    const withSandbox = (sandboxAvailability: string, sandboxUnavailableReason?: string) =>
      ({
        ...base,
        initializeResult: {
          ...base.initializeResult,
          sandboxAvailability,
          ...(sandboxUnavailableReason ? { sandboxUnavailableReason } : {}),
        },
      }) as MuseTransport;
    expect(assertMuseHostQualified(withSandbox("available"))).toBeUndefined();
    expect(assertMuseHostQualified(withSandbox("unavailable", "bubblewrapUnavailable"))).toContain(
      "bubblewrap",
    );
    expect(assertMuseHostQualified(withSandbox("unavailable", "userNamespacesDenied"))).toContain(
      "user namespaces",
    );
    expect(assertMuseHostQualified(withSandbox("unavailable"))).toContain("cannot enforce");
    expect(museSandboxUnavailableMessage(undefined, "win32")).toContain(
      "muse sandbox windows setup",
    );
    // An older host that predates the field is not treated as unavailable.
    expect(assertMuseHostQualified(base)).toBeUndefined();
  });
});
