export type ActiveParticle = {
  alpha: number;
  drift: number;
  driftPhase: number;
  driftRate: number;
  radius: number;
  terminalVelocity: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
};

export type SettledParticle = {
  alpha: number;
  jitter: number;
  radius: number;
  xRatio: number;
};

export type PointerState = {
  active: boolean;
  lastMove: number;
  speed: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
};

export const POINTER_RADIUS = 170;
export const POINTER_STRENGTH = 0.26;
export const FOOTER_OFFSET = 2;
export const FOOTER_BOTTOM_INSET = 8;
export const MAX_SETTLED_PARTICLES = 8_000;
export const PILE_BIN_WIDTH = 4;
export const PILE_LAYER_HEIGHT = 1.25;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function parseParticleColor(canvas: HTMLCanvasElement): string {
  const rgbValue = getComputedStyle(canvas).getPropertyValue("--home-particle-rgb").trim();
  return rgbValue || "182 182 182";
}

export function createActiveParticle(width: number, reducedMotion: boolean): ActiveParticle {
  const radius = reducedMotion ? randomBetween(1.1, 1.8) : randomBetween(0.9, 2.4);
  const baseDownwardVelocity = reducedMotion
    ? randomBetween(0.075, 0.14)
    : randomBetween(0.085, 0.2);

  return {
    alpha: reducedMotion ? randomBetween(0.14, 0.3) : randomBetween(0.18, 0.42),
    drift: randomBetween(0.02, 0.09),
    driftPhase: randomBetween(0, Math.PI * 2),
    driftRate: randomBetween(0.007, 0.018),
    radius,
    terminalVelocity: baseDownwardVelocity * randomBetween(1.35, 1.8),
    vx: randomBetween(-0.06, 0.06),
    vy: baseDownwardVelocity,
    x: randomBetween(-40, width + 40),
    y: randomBetween(-140, -12),
  };
}
