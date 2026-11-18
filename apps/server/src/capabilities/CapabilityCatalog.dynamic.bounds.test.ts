import { describe, expect, it } from "vitest";

import { BIGBUD_CAPABILITY_TRACKS } from "./BigbudCapabilityTracks.ts";
import { createCapabilityCatalog } from "./CapabilityCatalog.ts";
import {
  getEffectiveCapabilityCatalog,
  MAX_EFFECTIVE_CAPABILITY_CATALOG_THREADS,
  setEffectiveCapabilityCatalog,
} from "./CapabilityCatalog.dynamic.ts";

const catalog = createCapabilityCatalog([...BIGBUD_CAPABILITY_TRACKS]);
const threadId = (index: number) => `bounds-thread-${index}`;

describe("effective capability catalog bounds", () => {
  it("evicts the least recently used thread beyond the cap", () => {
    for (let index = 0; index < MAX_EFFECTIVE_CAPABILITY_CATALOG_THREADS; index += 1) {
      setEffectiveCapabilityCatalog(threadId(index), catalog);
    }
    // Reading thread 0 makes it recent, so thread 1 is the oldest when the cap is exceeded.
    expect(getEffectiveCapabilityCatalog(threadId(0))).toBe(catalog);
    for (let extra = 0; extra < 3; extra += 1) {
      setEffectiveCapabilityCatalog(
        threadId(MAX_EFFECTIVE_CAPABILITY_CATALOG_THREADS + extra),
        catalog,
      );
    }

    expect(getEffectiveCapabilityCatalog(threadId(0))).toBe(catalog);
    expect(getEffectiveCapabilityCatalog(threadId(1))).toBeUndefined();
    expect(getEffectiveCapabilityCatalog(threadId(2))).toBeUndefined();
    expect(getEffectiveCapabilityCatalog(threadId(3))).toBeUndefined();
    expect(getEffectiveCapabilityCatalog(threadId(4))).toBe(catalog);
    const retained = Array.from(
      { length: MAX_EFFECTIVE_CAPABILITY_CATALOG_THREADS + 3 },
      (_, index) => getEffectiveCapabilityCatalog(threadId(index)),
    ).filter((entry) => entry !== undefined);
    expect(retained).toHaveLength(MAX_EFFECTIVE_CAPABILITY_CATALOG_THREADS);
  });
});
