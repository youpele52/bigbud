import {
  CUA_CURSOR_THEME_ID,
  CUA_CURSOR_THEME_VERSION,
} from "@bigbud/shared/cua-driver/cursorTheme";

import {
  CANVAS,
  FPS,
  type JsonObject,
  type PathVertex,
  type Point,
  type Rgba,
  animated,
  ellipse,
  fill,
  lottieAnimation,
  pathShape,
  shapeLayer,
  staticValue,
  stroke,
} from "./lottie.ts";

/**
 * The in-app browser's agent cursor (`BrowserPanel.agentCursor.tsx`): lucide
 * `MousePointer2` at `size-8`, `fill-info text-info`, `drop-shadow-md`.
 *
 * cua-driver renders the 128-unit canvas as a 42pt footprint, so 4 canvas
 * units per lucide unit draws the arrow at the same ~22pt as the browser's
 * 32px icon. `info` is Tailwind v4 `blue-500` (`oklch(62.3% 0.214 259.815)`,
 * #2b7fff) in both light and dark themes.
 */
const LUCIDE_TO_CANVAS = 4;
const CANVAS_OFFSET = 22;
const STROKE_WIDTH = 2 * LUCIDE_TO_CANVAS;
const INFO: Rgba = [0.1693, 0.498, 1, 1];
const BLACK: Rgba = [0, 0, 0, 1];
/** Outer edge of the stroked, rounded tip: where the agent's action lands. */
export const HOTSPOT: Point = [36, 36];

/**
 * lucide `mouse-pointer-2` is four straight edges joined by circular arcs
 * (`M4.037 4.688a.495.495…z`). Each arc is listed by its endpoints and radius;
 * the edges between them are implied.
 */
const LUCIDE_POINTER_ARCS: ReadonlyArray<{
  readonly from: Point;
  readonly to: Point;
  readonly radius: number;
}> = [
  { from: [4.037, 4.688], to: [4.688, 4.037], radius: 0.495 },
  { from: [20.688, 10.537], to: [20.625, 11.484], radius: 0.5 },
  { from: [14.501, 13.064], to: [13.063, 14.499], radius: 2 },
  { from: [11.484, 20.625], to: [10.537, 20.688], radius: 0.5 },
];

function unit(from: Point, to: Point): Point {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

/**
 * `Math.acos`/`Math.tan` may differ in the last bit between JavaScript engines
 * (Bun and Node do), so geometry is rounded to keep the source reproducible.
 */
const round = (value: number): number => Math.round(value * 1000) / 1000;
const toCanvas = (point: Point): Point => [
  round(CANVAS_OFFSET + point[0] * LUCIDE_TO_CANVAS),
  round(CANVAS_OFFSET + point[1] * LUCIDE_TO_CANVAS),
];
const scaled = (vector: Point, length: number): Point => [
  round(vector[0] * length * LUCIDE_TO_CANVAS),
  round(vector[1] * length * LUCIDE_TO_CANVAS),
];

/**
 * Each arc is tangent to its neighbouring edges, so its cubic handles lie
 * along those edges with the standard length `4/3 · tan(θ/4) · r`.
 */
export function pointerVertices(): ReadonlyArray<PathVertex> {
  return LUCIDE_POINTER_ARCS.flatMap((arc, index) => {
    const previous = LUCIDE_POINTER_ARCS.at(index - 1)!;
    const next = LUCIDE_POINTER_ARCS[(index + 1) % LUCIDE_POINTER_ARCS.length]!;
    const incoming = unit(previous.to, arc.from);
    const outgoing = unit(arc.to, next.from);
    const cosine = Math.min(1, Math.max(-1, incoming[0] * outgoing[0] + incoming[1] * outgoing[1]));
    const handle = (4 / 3) * Math.tan(Math.acos(cosine) / 4) * arc.radius;
    return [
      { at: toCanvas(arc.from), in: [0, 0], out: scaled(incoming, handle) },
      { at: toCanvas(arc.to), in: scaled(outgoing, -handle), out: [0, 0] },
    ];
  });
}

const POINTER_PATH = pathShape(pointerVertices(), "Pointer");

/**
 * `drop-shadow-md` is `0 3px 3px rgb(0 0 0 / 0.12)`; the browser draws 0.75
 * lucide units per px, so 3px is 9 canvas units. Profile v2 has no blur, so
 * widening low-opacity strokes approximate the falloff.
 */
const SHADOW_OFFSET_Y = 9;
const SHADOW_STROKES: ReadonlyArray<readonly [extraWidth: number, opacity: number]> = [
  [18, 1.5],
  [12, 2.5],
  [6, 3.5],
  [0, 5],
];

function pointerLayers(frames: number, scale?: JsonObject): ReadonlyArray<JsonObject> {
  const shadowMotion = {
    anchor: HOTSPOT,
    position: staticValue([HOTSPOT[0], HOTSPOT[1] + SHADOW_OFFSET_Y]),
    ...(scale ? { scale } : {}),
  };
  const shadows = SHADOW_STROKES.map(([extraWidth, opacity], index) =>
    shapeLayer({
      index: index + 1,
      name: `Pointer shadow ${extraWidth}`,
      shapes: [
        POINTER_PATH,
        ...(extraWidth === 0 ? [fill(BLACK, opacity)] : []),
        stroke(BLACK, STROKE_WIDTH + extraWidth, opacity),
      ],
      frames,
      motion: shadowMotion,
    }),
  );
  const body = shapeLayer({
    index: shadows.length + 1,
    name: "Pointer",
    shapes: [POINTER_PATH, fill(INFO), stroke(INFO, STROKE_WIDTH)],
    frames,
    motion: { anchor: HOTSPOT, ...(scale ? { scale } : {}) },
  });
  return [...shadows, body];
}

const still = (name: string) => lottieAnimation(name, 1, pointerLayers(1));

/** A held press (drag) keeps the pointer slightly pushed in. */
const pressed = (name: string) => lottieAnimation(name, 1, pointerLayers(1, staticValue([92, 92])));

/** A one-shot nudge for actions without a click target (keys, app launch). */
function pulse(name: string): JsonObject {
  const frames = 12;
  const scale = animated([
    [0, [100, 100]],
    [4, [92, 92]],
    [8, [103, 103]],
    [12, [100, 100]],
  ]);
  return lottieAnimation(name, frames, pointerLayers(frames, scale));
}

/**
 * Accessibility clicks snap the cursor instead of gliding, so the click also
 * draws a ripple at the hotspot to keep the target visible.
 */
function click(): JsonObject {
  const frames = 20;
  const scale = animated([
    [0, [100, 100]],
    [6, [88, 88]],
    [12, [104, 104]],
    [20, [100, 100]],
  ]);
  const ripple = shapeLayer({
    index: 10,
    name: "Click ripple",
    shapes: [ellipse(HOTSPOT, 24, "Ripple"), stroke(INFO, 3)],
    frames,
    motion: {
      anchor: HOTSPOT,
      scale: animated([
        [0, [40, 40]],
        [20, [220, 220]],
      ]),
      opacity: animated([
        [0, 0],
        [3, 80],
        [20, 0],
      ]),
    },
  });
  return lottieAnimation("action_click", frames, [ripple, ...pointerLayers(frames, scale)]);
}

const ACTION_ANIMATIONS = {
  idle: () => still("action_idle"),
  observe: () => still("action_observe"),
  click,
  drag: () => pressed("action_drag"),
  scroll: () => still("action_scroll"),
  text: () => still("action_text"),
  key: () => pulse("action_key"),
  navigate: () => pulse("action_navigate"),
  app: () => pulse("action_app"),
  transfer: () => still("action_transfer"),
  record: () => still("action_record"),
  system: () => pulse("action_system"),
} as const satisfies Record<string, () => JsonObject>;

export const CURSOR_ACTIONS = Object.keys(ACTION_ANIMATIONS) as ReadonlyArray<
  keyof typeof ACTION_ANIMATIONS
>;

export function cursorAnimations(): ReadonlyMap<string, JsonObject> {
  return new Map(CURSOR_ACTIONS.map((action) => [`action_${action}`, ACTION_ANIMATIONS[action]()]));
}

export function cursorSemanticManifest(): JsonObject {
  return {
    schema: "cua.cursor-theme/2",
    id: CUA_CURSOR_THEME_ID,
    name: "bigbud Agent Cursor",
    version: CUA_CURSOR_THEME_VERSION,
    author: "bigbud",
    license: "MIT",
    compatibility: { profile: "cua-driver-actions-v2", semantics: 2 },
    canvas: { width: CANVAS, height: CANVAS, fps: FPS },
    hotspot: { x: HOTSPOT[0], y: HOTSPOT[1] },
    actions: Object.fromEntries(
      CURSOR_ACTIONS.map((action) => [action, { animation: `action_${action}`, still_frame: 0 }]),
    ),
  };
}
