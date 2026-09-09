import { describe, expect, it } from "vitest";

import {
  overlayVerifiedEffortCache,
  verifiedEffortEntriesFromModels,
} from "./effortCache.merge.ts";
import {
  rememberEffortCacheEntries,
  resetEffortCapabilityCacheForTests,
  effortCacheKey,
} from "./effortCache.ts";
import { makeEffortCacheIdentity } from "./effortCache.identity.ts";
import { decodeEffortCacheFile } from "./effortCache.decode.ts";
import { peekEffortCapabilityCache } from "./effortCache.persist.ts";

describe("effort capability cache", () => {
  it("overlays last verified options onto seed metadata and rejects stale generations", () => {
    resetEffortCapabilityCacheForTests();
    const identity = makeEffortCacheIdentity({
      provider: "opencode",
      executionIdentity: "/usr/bin/opencode",
      configFingerprint: "models:a",
      workspaceFingerprint: "/tmp/project",
      subProviderID: "openai",
      modelID: "gpt-5.4",
    });
    rememberEffortCacheEntries({
      stateDir: "/tmp/state",
      generation: 2,
      entries: [
        [
          effortCacheKey(identity),
          {
            status: "verified-supported",
            levels: [{ value: "xhigh", label: "Extra High" }],
            verifiedAt: "2026-09-09T12:00:00.000Z",
            generation: 2,
          },
        ],
      ],
    });
    rememberEffortCacheEntries({
      stateDir: "/tmp/state",
      generation: 1,
      entries: [
        [
          effortCacheKey(identity),
          {
            status: "verified-supported",
            levels: [{ value: "low", label: "Low" }],
            verifiedAt: "2026-09-09T12:01:00.000Z",
            generation: 1,
          },
        ],
      ],
    });

    const overlaid = overlayVerifiedEffortCache({
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          subProviderID: "openai",
          capabilities: {
            reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
            effortMetadataStatus: "seed",
            effortMetadataOrigin: "seed",
          },
        },
      ],
      entries: peekEffortCapabilityCache("/tmp/state").entries,
      identityFor: () => identity,
    });

    expect(overlaid[0]?.capabilities?.reasoningEffortLevels.map((level) => level.value)).toEqual([
      "xhigh",
    ]);
    expect(overlaid[0]?.capabilities?.effortMetadataOrigin).toBe("cache");
  });

  it("does not overlay cache onto a different configuration fingerprint", () => {
    resetEffortCapabilityCacheForTests();
    const cached = makeEffortCacheIdentity({
      provider: "opencode",
      executionIdentity: "/usr/bin/opencode",
      configFingerprint: "models:a",
      workspaceFingerprint: "/tmp/project",
      subProviderID: "openai",
      modelID: "gpt-5.4",
    });
    rememberEffortCacheEntries({
      stateDir: "/tmp/state-scope",
      generation: 1,
      entries: [
        [
          effortCacheKey(cached),
          {
            status: "verified-supported",
            levels: [{ value: "xhigh", label: "Extra High" }],
            verifiedAt: "2026-09-09T12:00:00.000Z",
            generation: 1,
          },
        ],
      ],
    });
    const liveIdentity = makeEffortCacheIdentity({
      provider: "opencode",
      executionIdentity: "/usr/bin/opencode",
      configFingerprint: "models:b",
      workspaceFingerprint: "/tmp/project",
      subProviderID: "openai",
      modelID: "gpt-5.4",
    });
    const overlaid = overlayVerifiedEffortCache({
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          subProviderID: "openai",
          capabilities: {
            reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
            effortMetadataStatus: "seed",
            effortMetadataOrigin: "seed",
          },
        },
      ],
      entries: peekEffortCapabilityCache("/tmp/state-scope").entries,
      identityFor: () => liveIdentity,
    });
    expect(overlaid[0]?.capabilities?.reasoningEffortLevels.map((level) => level.value)).toEqual([
      "high",
    ]);
  });

  it("drops corrupt cache payloads instead of fabricating entries", () => {
    expect(decodeEffortCacheFile("{not json")).toBeNull();
    expect(decodeEffortCacheFile({ version: 99, entries: {} })).toBeNull();
    expect(
      decodeEffortCacheFile({
        version: 1,
        entries: {
          bad: { status: "verified-supported", levels: [], verifiedAt: "t", generation: 1 },
        },
      })?.entries,
    ).toEqual({});
  });

  it("does not re-save a cache overlay as a fresh provider report", () => {
    const entries = verifiedEffortEntriesFromModels({
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [{ value: "xhigh", label: "Extra High" }],
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
            effortMetadataStatus: "verified-supported",
            effortMetadataOrigin: "cache",
          },
        },
      ],
      identityFor: () =>
        makeEffortCacheIdentity({
          provider: "opencode",
          executionIdentity: "opencode",
          configFingerprint: "cfg",
          workspaceFingerprint: "ws",
          modelID: "gpt-5.4",
        }),
      generation: 1,
      verifiedAt: "2026-09-09T12:00:00.000Z",
    });

    expect(entries).toEqual([]);
  });
});
