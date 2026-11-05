/**
 * Minimal Lottie builders for the bounded cua-driver cursor-theme profile v2:
 * shape layers with static geometry, solid fills and strokes, and animation
 * only on the layer transform (position, scale, rotation, opacity). Groups,
 * masks, effects, parenting, images and animated geometry are rejected by the
 * `cua-cursor-theme` compiler, so these helpers cannot express them.
 */

export const CANVAS = 128;
export const FPS = 30;

export type Point = readonly [number, number];
export type Rgba = readonly [number, number, number, number];
export type JsonObject = { readonly [key: string]: unknown };

/** One path vertex with its in/out Bezier tangents, relative to the vertex. */
export interface PathVertex {
  readonly at: Point;
  readonly in: Point;
  readonly out: Point;
}

export function staticValue(value: unknown): JsonObject {
  return { a: 0, k: value };
}

function keyframeValue(value: number | readonly number[]): readonly number[] {
  return typeof value === "number" ? [value] : value;
}

/** Eased keyframes matching the upstream default theme's ease-out curve. */
export function animated(
  values: ReadonlyArray<readonly [frame: number, value: number | readonly number[]]>,
): JsonObject {
  return {
    a: 1,
    k: values.map(([frame, value], index) => {
      const next = values[index + 1];
      return next
        ? {
            t: frame,
            s: keyframeValue(value),
            e: keyframeValue(next[1]),
            i: { x: [0.25], y: [1] },
            o: { x: [0.2], y: [0.75] },
          }
        : { t: frame, s: keyframeValue(value) };
    }),
  };
}

export function pathShape(vertices: ReadonlyArray<PathVertex>, name: string): JsonObject {
  return {
    ty: "sh",
    nm: name,
    ks: staticValue({
      i: vertices.map((vertex) => vertex.in),
      o: vertices.map((vertex) => vertex.out),
      v: vertices.map((vertex) => vertex.at),
      c: true,
    }),
  };
}

export function ellipse(center: Point, diameter: number, name: string): JsonObject {
  return { ty: "el", nm: name, p: staticValue(center), s: staticValue([diameter, diameter]), d: 1 };
}

export function fill(color: Rgba, opacity = 100): JsonObject {
  return { ty: "fl", c: staticValue(color), o: staticValue(opacity), r: 1 };
}

/** Round caps and joins, matching lucide's `stroke-linecap/linejoin="round"`. */
export function stroke(color: Rgba, width: number, opacity = 100): JsonObject {
  return {
    ty: "st",
    c: staticValue(color),
    o: staticValue(opacity),
    w: staticValue(width),
    lc: 2,
    lj: 2,
    ml: 4,
  };
}

const IDENTITY_SHAPE_TRANSFORM: JsonObject = {
  ty: "tr",
  p: staticValue([0, 0]),
  a: staticValue([0, 0]),
  s: staticValue([100, 100]),
  r: staticValue(0),
  o: staticValue(100),
  sk: staticValue(0),
  sa: staticValue(0),
};

export interface LayerMotion {
  /** Fixed pivot for scale/rotation, in canvas coordinates. */
  readonly anchor: Point;
  readonly position?: JsonObject;
  readonly scale?: JsonObject;
  readonly opacity?: JsonObject;
}

export function shapeLayer(input: {
  readonly index: number;
  readonly name: string;
  readonly shapes: ReadonlyArray<JsonObject>;
  readonly frames: number;
  readonly motion: LayerMotion;
}): JsonObject {
  const { anchor, position, scale, opacity } = input.motion;
  return {
    ddd: 0,
    ind: input.index,
    ty: 4,
    nm: input.name,
    sr: 1,
    ks: {
      o: opacity ?? staticValue(100),
      r: staticValue(0),
      p: position ?? staticValue(anchor),
      a: staticValue(anchor),
      s: scale ?? staticValue([100, 100]),
    },
    ao: 0,
    shapes: [...input.shapes, IDENTITY_SHAPE_TRANSFORM],
    ip: 0,
    op: input.frames,
    st: 0,
    bm: 0,
  };
}

/** `layers` are listed bottom-to-top; Lottie draws the first layer on top. */
export function lottieAnimation(
  name: string,
  frames: number,
  layers: ReadonlyArray<JsonObject>,
): JsonObject {
  return {
    v: "5.12.2",
    fr: FPS,
    ip: 0,
    op: frames,
    w: CANVAS,
    h: CANVAS,
    nm: name,
    ddd: 0,
    assets: [],
    layers: [...layers].toReversed(),
    markers: [],
  };
}
