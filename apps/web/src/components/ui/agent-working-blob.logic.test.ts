import { describe, expect, it } from "vitest";

import {
  AGENT_WORKING_BLOB_MIN_SIZE,
  AGENT_WORKING_BLOB_SATELLITE_COUNT,
} from "~/constants/agentWorkingBlob";
import {
  blobColorMix,
  clampBlobSize,
  createBlobMotion,
  isBlobSettled,
  layoutBlob,
  stepBlobMotion,
  toSvgId,
} from "./agent-working-blob.logic";

/** Deterministic pseudo-random source so motion tests are repeatable. */
function seeded(seed = 7): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

describe("clampBlobSize", () => {
  it("enforces the inline minimum but has no maximum", () => {
    expect(clampBlobSize(2)).toBe(AGENT_WORKING_BLOB_MIN_SIZE);
    expect(clampBlobSize(14)).toBe(14);
    expect(clampBlobSize(480)).toBe(480);
    expect(clampBlobSize(Number.NaN)).toBe(AGENT_WORKING_BLOB_MIN_SIZE);
  });
});

describe("toSvgId", () => {
  it("strips characters that break url(#id) references", () => {
    expect(toSvgId(":r1:")).toBe("agent-blob-r1");
    expect(toSvgId("«r2»")).toBe("agent-blob-r2");
  });
});

describe("blob motion", () => {
  it("keeps every droplet inside the viewBox while working", () => {
    const random = seeded();
    const motion = createBlobMotion(false, random);
    expect(motion.satellites).toHaveLength(AGENT_WORKING_BLOB_SATELLITE_COUNT);
    for (let frame = 0; frame < 600; frame++) {
      stepBlobMotion(motion, 1 / 60, 0, random);
      for (const drop of layoutBlob(motion, frame / 60, true).satellites) {
        expect(drop.cx - drop.r).toBeGreaterThanOrEqual(0);
        expect(drop.cx + drop.r).toBeLessThanOrEqual(100);
        expect(drop.cy - drop.r).toBeGreaterThanOrEqual(0);
        expect(drop.cy + drop.r).toBeLessThanOrEqual(100);
      }
    }
  });

  it("merges every droplet into the core when done and then reports settled", () => {
    const random = seeded();
    const motion = createBlobMotion(false, random);
    for (let frame = 0; frame < 240 && !isBlobSettled(motion, 1); frame++) {
      stepBlobMotion(motion, 1 / 60, 1, random);
    }
    expect(isBlobSettled(motion, 1)).toBe(true);
    for (const drop of layoutBlob(motion, 3, true).satellites) {
      expect(drop.cx).toBeCloseTo(50);
      expect(drop.cy).toBeCloseTo(50);
    }
  });

  it("starts already settled when mounted done, and is never settled while working", () => {
    expect(isBlobSettled(createBlobMotion(true), 1)).toBe(true);
    expect(isBlobSettled(createBlobMotion(true), 0)).toBe(false);
  });

  it("ignores negative frame times instead of producing NaN positions", () => {
    const motion = createBlobMotion(false, seeded());
    stepBlobMotion(motion, -0.5, 0, seeded());
    const layout = layoutBlob(motion, 1, true);
    for (const drop of [layout.core, ...layout.satellites]) {
      expect(Number.isFinite(drop.cx) && Number.isFinite(drop.cy) && Number.isFinite(drop.r)).toBe(
        true,
      );
    }
  });
});

describe("blobColorMix", () => {
  it("starts on the working colour, reaches the shift colour mid-cycle and stays in range", () => {
    expect(blobColorMix(0, 10)).toBeCloseTo(1);
    expect(blobColorMix(5, 10)).toBeCloseTo(0);
    for (let t = 0; t < 20; t += 0.25) {
      const mix = blobColorMix(t, 10);
      expect(mix).toBeGreaterThanOrEqual(0);
      expect(mix).toBeLessThanOrEqual(1);
    }
  });
});
