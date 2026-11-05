import {
  AGENT_WORKING_BLOB_MIN_SIZE,
  AGENT_WORKING_BLOB_SATELLITE_COUNT,
  AGENT_WORKING_BLOB_SHIFT_PERIOD_SECONDS,
} from "~/constants/agentWorkingBlob";

/** All geometry lives in a 100×100 viewBox; the SVG scales it to the requested size. */
export const BLOB_VIEWBOX = 100;
const CENTER = BLOB_VIEWBOX / 2;
const TAU = Math.PI * 2;
const CORE_RADIUS = 22;
const MERGED_CORE_RADIUS = 34;

export interface BlobSatellite {
  readonly id: string;
  angle: number;
  omega: number;
  readonly omega0: number;
  readonly radius: number;
  readonly reach: number;
  readonly amp: number;
  readonly freq: number;
  readonly phase: number;
}

export interface BlobMotion {
  readonly satellites: BlobSatellite[];
  /** 0 = droplets dancing apart, 1 = merged into one settled drop. */
  merge: number;
}

export interface BlobCircle {
  readonly id: string;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

export interface BlobLayout {
  readonly core: BlobCircle;
  readonly satellites: ReadonlyArray<BlobCircle>;
  readonly sheen: { readonly cx: number; readonly cy: number };
}

export type RandomSource = () => number;

const between = (random: RandomSource, min: number, max: number) => min + random() * (max - min);

function gauss(random: RandomSource): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(TAU * random());
}

export function clampBlobSize(size: number): number {
  return Number.isFinite(size)
    ? Math.max(AGENT_WORKING_BLOB_MIN_SIZE, size)
    : AGENT_WORKING_BLOB_MIN_SIZE;
}

/** SVG `url(#id)` references break on the `:` characters React's `useId` can produce. */
export function toSvgId(reactId: string): string {
  return `agent-blob-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function createBlobMotion(
  merged: boolean,
  random: RandomSource = Math.random,
  count = AGENT_WORKING_BLOB_SATELLITE_COUNT,
): BlobMotion {
  const satellites = Array.from({ length: count }, (_, index): BlobSatellite => {
    const omega0 = between(random, 0.5, 1.1) * (index % 2 ? -1 : 1);
    return {
      id: `drop-${index}`,
      angle: (index / count) * TAU,
      omega: omega0,
      omega0,
      radius: between(random, 7, 10),
      reach: between(random, 17, 22),
      amp: between(random, 6, 9),
      freq: between(random, 0.55, 1.05),
      phase: between(random, 0, TAU),
    };
  });
  return { satellites, merge: merged ? 1 : 0 };
}

/** Advances the droplets: angular speed random-walks around its base, so the dance never loops. */
export function stepBlobMotion(
  motion: BlobMotion,
  dtSeconds: number,
  targetMerge: number,
  random: RandomSource = Math.random,
): void {
  const dt = Math.max(0, dtSeconds);
  motion.merge += (targetMerge - motion.merge) * Math.min(1, dt * 4);
  if (Math.abs(targetMerge - motion.merge) < 0.002) motion.merge = targetMerge;
  const noise = Math.sqrt(dt);
  for (const satellite of motion.satellites) {
    satellite.omega +=
      (satellite.omega0 - satellite.omega) * 0.8 * dt + gauss(random) * 0.9 * noise;
    satellite.angle += satellite.omega * dt;
  }
}

export function isBlobSettled(motion: BlobMotion, targetMerge: number): boolean {
  return targetMerge === 1 && motion.merge === 1;
}

export function layoutBlob(motion: BlobMotion, timeSeconds: number, animate: boolean): BlobLayout {
  const t = animate ? timeSeconds : 1.3;
  const spread = 1 - motion.merge;
  const breathe = animate ? 1 + 0.06 * Math.sin(t * 2.2) : 1;
  return {
    core: {
      id: "core",
      cx: CENTER,
      cy: CENTER,
      r: (CORE_RADIUS + (MERGED_CORE_RADIUS - CORE_RADIUS) * motion.merge) * breathe,
    },
    satellites: motion.satellites.map((satellite) => {
      // reach out far enough to pinch off, then fall back and melt in
      const distance =
        (satellite.reach + satellite.amp * Math.sin(t * satellite.freq + satellite.phase)) * spread;
      return {
        id: satellite.id,
        cx: CENTER + Math.cos(satellite.angle) * distance,
        cy: CENTER + Math.sin(satellite.angle) * distance,
        r: satellite.radius * (0.6 + 0.4 * spread),
      };
    }),
    sheen: { cx: 40 + 6 * Math.sin(t * 0.7), cy: 36 + 4 * Math.cos(t * 0.9) },
  };
}

const smoothstep = (x: number) => x * x * (3 - 2 * x);

/**
 * Share of the working colour (1) versus the shift colour (0). Driven by one shared clock so every
 * loader on screen shifts in sync; it lingers on each colour and glides between them.
 */
export function blobColorMix(
  timeSeconds: number,
  periodSeconds = AGENT_WORKING_BLOB_SHIFT_PERIOD_SECONDS,
): number {
  const wave = 0.5 + 0.5 * Math.cos((timeSeconds * TAU) / periodSeconds);
  return smoothstep(smoothstep(wave));
}
