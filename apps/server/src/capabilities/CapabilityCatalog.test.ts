import { describe, expect, it } from "vitest";

import { BIGBUD_CAPABILITY_CATALOG } from "./BigbudCapabilityTracks.ts";
import {
  createCapabilityCatalog,
  estimateCapabilityTokens,
  LP_TARGET_TOKEN_LIMIT,
  SKIT_HARD_TOKEN_LIMIT,
  SKIT_TARGET_TOKEN_LIMIT,
  validateCapabilityCatalog,
} from "./CapabilityCatalog.ts";
import {
  serializeCapabilityDelta,
  serializeCapabilityLp,
  serializeCapabilitySkit,
} from "./CapabilityCatalog.serialize.ts";

describe("capability catalog", () => {
  it("registers unique, valid, lowercase bigbud Tracks", () => {
    expect(validateCapabilityCatalog(BIGBUD_CAPABILITY_CATALOG)).toEqual([]);
    expect(BIGBUD_CAPABILITY_CATALOG.tracks.length).toBeGreaterThan(0);
    expect(new Set(BIGBUD_CAPABILITY_CATALOG.tracks.map((track) => track.id)).size).toBe(
      BIGBUD_CAPABILITY_CATALOG.tracks.length,
    );
  });

  it("creates deterministic revisions independent of input ordering", () => {
    const reversed = createCapabilityCatalog(BIGBUD_CAPABILITY_CATALOG.tracks.toReversed());
    expect(reversed.revision).toBe(BIGBUD_CAPABILITY_CATALOG.revision);
    expect(reversed.tracks.map((track) => track.id)).toEqual(
      BIGBUD_CAPABILITY_CATALOG.tracks.map((track) => track.id),
    );
  });

  it("reports missing related Tracks", () => {
    const catalog = createCapabilityCatalog([
      {
        ...BIGBUD_CAPABILITY_CATALOG.tracks[0]!,
        relatedCapabilityIds: ["missing.track"],
      },
    ]);
    expect(validateCapabilityCatalog(catalog)).toContain(
      `Missing related capability missing.track from ${catalog.tracks[0]!.id}`,
    );
  });
});

describe("capability context serialization", () => {
  it("serializes a bounded LP with logical Track URIs", () => {
    const lp = serializeCapabilityLp({
      catalog: BIGBUD_CAPABILITY_CATALOG,
      context: {
        threadId: "thread-1",
        threadTitle: "Capability work",
        provider: "codex",
        role: "main",
      },
    });
    expect(lp).toContain(`Catalog revision: ${BIGBUD_CAPABILITY_CATALOG.revision}`);
    expect(lp).toContain("bigbud://capabilities/thread.create");
    expect(lp).not.toMatch(/\/Users\/|BigBud|Bigbud|bigBud/);
    expect(estimateCapabilityTokens(lp)).toBeLessThanOrEqual(LP_TARGET_TOKEN_LIMIT);
  });

  it("serializes a routine Skit within its target and hard budgets", () => {
    const skit = serializeCapabilitySkit(BIGBUD_CAPABILITY_CATALOG.revision);
    const tokens = estimateCapabilityTokens(skit);
    expect(tokens).toBeGreaterThanOrEqual(40);
    expect(tokens).toBeLessThanOrEqual(SKIT_TARGET_TOKEN_LIMIT);
    expect(tokens).toBeLessThanOrEqual(SKIT_HARD_TOKEN_LIMIT);
    expect(skit).toContain("read_capability_guide");
    expect(skit).toContain("self-contained tasks");
  });

  it("serializes a bounded capability delta", () => {
    const delta = serializeCapabilityDelta(
      BIGBUD_CAPABILITY_CATALOG.revision,
      "Connected MCP capability availability changed.",
    );
    expect(delta).toContain("<bigbud_capability_delta>");
    expect(estimateCapabilityTokens(delta)).toBeLessThanOrEqual(SKIT_HARD_TOKEN_LIMIT);
  });
});
