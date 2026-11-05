import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CURSOR_ACTIONS,
  HOTSPOT,
  cursorAnimations,
  cursorSemanticManifest,
} from "./bigbudCursor.ts";
import {
  ARTIFACT_MODULE_PATH,
  COMPILED_PATH,
  SOURCE_PATH,
  artifactModuleSource,
  buildCursorSource,
} from "./build.ts";
import { CANVAS, FPS, type JsonObject } from "./lottie.ts";

// cursor-overlay `theme_artifact.rs` limits for profile v2.
const MAX_FRAMES_PER_ANIMATION = 120;
const MAX_TOTAL_FRAMES = 1_000;
const BOUNDED_SHAPE_TYPES = new Set(["sh", "el", "fl", "st", "tr"]);

function shapeTypes(animation: JsonObject): string[] {
  const layers = animation.layers as ReadonlyArray<{ shapes: ReadonlyArray<{ ty: string }> }>;
  return layers.flatMap((layer) => layer.shapes.map((shape) => shape.ty));
}

describe("bigbud cua cursor theme", () => {
  it("defines every v2 semantic action within the frame budget", () => {
    const animations = cursorAnimations();
    expect(CURSOR_ACTIONS).toHaveLength(12);
    expect([...animations.keys()]).toEqual(CURSOR_ACTIONS.map((action) => `action_${action}`));
    let total = 0;
    for (const animation of animations.values()) {
      expect(animation).toMatchObject({ w: CANVAS, h: CANVAS, fr: FPS, ip: 0 });
      const frames = animation.op as number;
      expect(frames).toBeGreaterThanOrEqual(1);
      expect(frames).toBeLessThanOrEqual(MAX_FRAMES_PER_ANIMATION);
      total += frames;
      // Groups, images, masks and effects are outside the bounded profile.
      expect(shapeTypes(animation).filter((type) => !BOUNDED_SHAPE_TYPES.has(type))).toEqual([]);
    }
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_FRAMES);
  });

  it("puts the hotspot on the canvas and references each animation once", () => {
    const manifest = cursorSemanticManifest() as {
      hotspot: { x: number; y: number };
      actions: Record<string, { animation: string; still_frame: number }>;
    };
    expect(manifest.hotspot).toEqual({ x: HOTSPOT[0], y: HOTSPOT[1] });
    expect(HOTSPOT.every((value) => value > 0 && value < CANVAS)).toBe(true);
    expect(Object.keys(manifest.actions)).toEqual([...CURSOR_ACTIONS]);
    for (const [action, entry] of Object.entries(manifest.actions)) {
      expect(entry.animation).toBe(`action_${action}`);
      expect(entry.still_frame).toBeLessThan(cursorAnimations().get(entry.animation)!.op as number);
    }
  });

  it("builds a byte-identical source archive", () => {
    expect(buildCursorSource().equals(buildCursorSource())).toBe(true);
  });

  // Fails when the artwork changes without recompiling: run
  // `bun scripts/cua-cursor-theme/build.ts --compiler <cua-driver>`.
  it("matches the checked-in source, compiled artifact and desktop module", () => {
    expect(buildCursorSource().equals(readFileSync(SOURCE_PATH))).toBe(true);
    expect(readFileSync(ARTIFACT_MODULE_PATH, "utf8")).toBe(
      artifactModuleSource(readFileSync(COMPILED_PATH)),
    );
  });
});
