type ActiveParticle = {
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

type SettledParticle = {
  alpha: number;
  jitter: number;
  radius: number;
  xRatio: number;
};

type PointerState = {
  active: boolean;
  lastMove: number;
  speed: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
};

const POINTER_RADIUS = 170;
const POINTER_STRENGTH = 0.26;
const FOOTER_OFFSET = 2;
const FOOTER_BOTTOM_INSET = 8;
const MAX_SETTLED_PARTICLES = 8_000;
const PILE_BIN_WIDTH = 4;
const PILE_LAYER_HEIGHT = 1.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function parseParticleColor(canvas: HTMLCanvasElement): string {
  const rgbValue = getComputedStyle(canvas).getPropertyValue("--home-particle-rgb").trim();
  return rgbValue || "182 182 182";
}

function createActiveParticle(width: number, reducedMotion: boolean): ActiveParticle {
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

export function initHomeBackgroundParticles(): void {
  const canvasNode = document.getElementById("home-background-particles");
  if (!(canvasNode instanceof HTMLCanvasElement) || canvasNode.dataset.initialized === "true") {
    return;
  }

  const pageNode = canvasNode.closest(".page");
  if (!(pageNode instanceof HTMLElement)) {
    return;
  }

  const footerNode = pageNode.querySelector(".footer");
  if (!(footerNode instanceof HTMLElement)) {
    return;
  }

  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const context = canvasNode.getContext("2d");
  if (context === null) {
    return;
  }

  const settledCanvas = document.createElement("canvas");
  const settledContext = settledCanvas.getContext("2d");
  if (settledContext === null) {
    return;
  }

  const activeContext: CanvasRenderingContext2D = context;
  const accumulationContext: CanvasRenderingContext2D = settledContext;
  const canvas = canvasNode;
  const footer = footerNode;
  const page = pageNode;

  canvas.dataset.initialized = "true";

  const pointer: PointerState = {
    active: false,
    lastMove: 0,
    speed: 0,
    vx: 0,
    vy: 0,
    x: 0,
    y: 0,
  };

  let activeParticles: ActiveParticle[] = [];
  let settledParticles: SettledParticle[] = [];
  let activeTarget = 0;
  let colorRgb = parseParticleColor(canvas);
  let devicePixelRatio = 1;
  let footerTop = 0;
  let frameHandle = 0;
  let height = 0;
  let isReducedMotion = mediaQuery.matches;
  let lastTimestamp = 0;
  let settledPileHeights: number[] = [];
  let time = 0;
  let width = 0;
  let windClock = randomBetween(0, Math.PI * 2);
  let windDrift = randomBetween(0.11, 0.19);

  function drawSettledParticle(particle: SettledParticle, pileHeights: number[]): void {
    const x = clamp(particle.xRatio * width, particle.radius, width - particle.radius);
    const binCount = pileHeights.length;
    const bin = clamp(Math.floor(x / PILE_BIN_WIDTH), 0, Math.max(0, binCount - 1));
    const pileDepth = pileHeights[bin] ?? 0;

    pileHeights[bin] = pileDepth + 1;

    const stackedY =
      footerTop - pileDepth * PILE_LAYER_HEIGHT - particle.radius * 0.4 - FOOTER_OFFSET;
    const jitterOffset = particle.jitter * PILE_BIN_WIDTH * 0.38;

    accumulationContext.fillStyle = `rgb(${colorRgb} / ${particle.alpha})`;
    accumulationContext.beginPath();
    accumulationContext.arc(x + jitterOffset, stackedY, particle.radius, 0, Math.PI * 2);
    accumulationContext.fill();
  }

  function rebuildSettledLayer(): void {
    accumulationContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    accumulationContext.clearRect(0, 0, width, height);

    settledPileHeights = Array.from(
      { length: Math.max(1, Math.ceil(width / PILE_BIN_WIDTH)) },
      () => 0,
    );

    for (const particle of settledParticles) {
      drawSettledParticle(particle, settledPileHeights);
    }
  }

  function setCanvasSize(): void {
    const nextWidth = Math.max(1, Math.round(page.clientWidth));
    const nextHeight = Math.max(1, Math.round(page.scrollHeight));

    if (nextWidth === width && nextHeight === height) {
      return;
    }

    const previousWidth = width || nextWidth;
    const widthScale = nextWidth / previousWidth;

    width = nextWidth;
    height = nextHeight;
    devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    const pageRect = page.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    footerTop = footerRect.bottom - pageRect.top - FOOTER_BOTTOM_INSET;
    footerTop = clamp(footerTop, 0, Math.max(0, height - 1));

    canvas.width = Math.round(width * devicePixelRatio);
    canvas.height = Math.round(height * devicePixelRatio);
    settledCanvas.width = Math.round(width * devicePixelRatio);
    settledCanvas.height = Math.round(height * devicePixelRatio);

    activeContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    for (const particle of activeParticles) {
      particle.x *= widthScale;
    }

    rebuildSettledLayer();
  }

  function syncParticleTarget(): void {
    const area = width * height;
    if (isReducedMotion) {
      activeTarget = clamp(Math.round(area / 21_000), 24, 48);
      return;
    }

    activeTarget = clamp(Math.round(area / 7_200), 130, 320);
  }

  function resetParticle(particle?: ActiveParticle): ActiveParticle {
    const nextParticle = particle ?? createActiveParticle(width, isReducedMotion);
    const replacement = createActiveParticle(width, isReducedMotion);

    nextParticle.alpha = replacement.alpha;
    nextParticle.drift = replacement.drift;
    nextParticle.driftPhase = replacement.driftPhase;
    nextParticle.driftRate = replacement.driftRate;
    nextParticle.radius = replacement.radius;
    nextParticle.terminalVelocity = replacement.terminalVelocity;
    nextParticle.vx = replacement.vx;
    nextParticle.vy = replacement.vy;
    nextParticle.x = replacement.x;
    nextParticle.y = replacement.y;

    return nextParticle;
  }

  function hydrateActiveParticles(): void {
    activeParticles = activeParticles.slice(0, activeTarget);

    while (activeParticles.length < activeTarget) {
      activeParticles.push(createActiveParticle(width, isReducedMotion));
    }
  }

  function settleParticle(index: number): void {
    const particle = activeParticles[index];
    if (!particle) {
      return;
    }

    if (settledParticles.length >= MAX_SETTLED_PARTICLES) {
      resetParticle(particle);
      return;
    }

    const settledParticle: SettledParticle = {
      alpha: clamp(particle.alpha + randomBetween(0.06, 0.16), 0.24, 0.52),
      jitter: randomBetween(-1, 1),
      radius: clamp(particle.radius * randomBetween(0.86, 1.1), 0.9, 2.6),
      xRatio: clamp(particle.x / width, 0, 1),
    };

    settledParticles.push(settledParticle);
    if (settledPileHeights.length === 0) {
      rebuildSettledLayer();
    } else {
      drawSettledParticle(settledParticle, settledPileHeights);
    }

    resetParticle(particle);
  }

  function updatePointer(event: PointerEvent): void {
    const pageRect = page.getBoundingClientRect();
    const nextX = event.clientX - pageRect.left;
    const nextY = event.clientY - pageRect.top;
    const previousX = pointer.x || nextX;
    const previousY = pointer.y || nextY;
    const deltaX = nextX - previousX;
    const deltaY = nextY - previousY;

    pointer.active = true;
    pointer.lastMove = performance.now();
    pointer.speed = Math.min(Math.hypot(deltaX, deltaY), 32);
    pointer.vx = deltaX;
    pointer.vy = deltaY;
    pointer.x = nextX;
    pointer.y = nextY;
  }

  function applyPointerForce(particle: ActiveParticle, deltaScale: number): void {
    if (!pointer.active || performance.now() - pointer.lastMove > 140) {
      return;
    }

    const dx = particle.x - pointer.x;
    const dy = particle.y - pointer.y;
    const distanceSquared = dx * dx + dy * dy;
    const radiusSquared = POINTER_RADIUS * POINTER_RADIUS;

    if (distanceSquared === 0 || distanceSquared > radiusSquared) {
      return;
    }

    const distance = Math.sqrt(distanceSquared);
    const falloff = 1 - distance / POINTER_RADIUS;
    const pointerVelocityInfluence = 1 + pointer.speed * 0.035;
    const force = POINTER_STRENGTH * falloff * falloff * pointerVelocityInfluence * deltaScale;
    const normalX = dx / distance;
    const normalY = dy / distance;

    particle.vx += normalX * force + pointer.vx * 0.0045 * falloff;
    particle.vy += normalY * force * 0.7 + pointer.vy * 0.0032 * falloff - force * 0.2;
  }

  function render(timestamp: number): void {
    if (document.hidden) {
      frameHandle = window.requestAnimationFrame(render);
      return;
    }

    if (lastTimestamp === 0) {
      lastTimestamp = timestamp;
    }

    const delta = Math.min((timestamp - lastTimestamp) / 16.6667, 2);
    lastTimestamp = timestamp;
    time += delta;
    windClock += delta * 0.014;

    const gust = Math.sin(windClock * 0.85) * 0.07 + Math.sin(windClock * 0.31 + 1.4) * 0.05;
    const wind = windDrift + gust;

    activeContext.clearRect(0, 0, width, height);
    activeContext.drawImage(settledCanvas, 0, 0, width, height);

    for (let index = 0; index < activeParticles.length; index += 1) {
      const particle = activeParticles[index];
      const wobble = Math.sin(time * particle.driftRate + particle.driftPhase) * particle.drift;

      particle.vx += (wind + wobble - particle.vx) * 0.014 * delta;
      particle.vy = Math.min(
        particle.terminalVelocity,
        particle.vy + (isReducedMotion ? 0.0011 : 0.0022) * delta,
      );

      applyPointerForce(particle, delta);

      particle.x += particle.vx * 8.5 * delta;
      particle.y += particle.vy * 8.9 * delta;

      if (particle.y >= footerTop - particle.radius * 0.25) {
        settleParticle(index);
        continue;
      }

      if (particle.x < -80 || particle.x > width + 80 || particle.y > height + 40) {
        resetParticle(particle);
        continue;
      }

      activeContext.fillStyle = `rgb(${colorRgb} / ${particle.alpha})`;
      activeContext.beginPath();
      activeContext.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      activeContext.fill();
    }

    frameHandle = window.requestAnimationFrame(render);
  }

  function handleResize(): void {
    setCanvasSize();
    syncParticleTarget();
    hydrateActiveParticles();
  }

  function handleVisibilityChange(): void {
    if (!document.hidden) {
      lastTimestamp = 0;
    }
  }

  function handleMotionPreferenceChange(event: MediaQueryListEvent): void {
    isReducedMotion = event.matches;
    windDrift = randomBetween(0.11, 0.19);
    syncParticleTarget();
    activeParticles = activeParticles.map((particle) => resetParticle(particle));
    hydrateActiveParticles();
  }

  const resizeObserver = new ResizeObserver(handleResize);

  resizeObserver.observe(page);
  resizeObserver.observe(footer);

  window.addEventListener("resize", handleResize, { passive: true });
  window.addEventListener("pointermove", updatePointer, { passive: true });
  document.addEventListener("visibilitychange", handleVisibilityChange);
  mediaQuery.addEventListener("change", handleMotionPreferenceChange);

  colorRgb = parseParticleColor(canvas);
  setCanvasSize();
  syncParticleTarget();
  hydrateActiveParticles();

  frameHandle = window.requestAnimationFrame(render);

  window.addEventListener(
    "pagehide",
    () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(frameHandle);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("pointermove", updatePointer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      mediaQuery.removeEventListener("change", handleMotionPreferenceChange);
    },
    { once: true },
  );
}
