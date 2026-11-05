import { blobColorMix } from "./agent-working-blob.logic";

export interface BlobFrame {
  /** Seconds on the shared clock. */
  readonly time: number;
  /** Seconds since the previous frame, clamped so a resumed tab does not jump. */
  readonly dt: number;
  /** Shared working/shift colour mix, so every loader on screen shifts in sync. */
  readonly mix: number;
}

type FrameListener = (frame: BlobFrame) => void;

const MAX_FRAME_SECONDS = 0.05;
const listeners = new Set<FrameListener>();
let frameId: number | null = null;
let lastFrameAt: number | null = null;
let visibilityBound = false;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function runFrame(now: number): void {
  frameId = null;
  // rAF timestamps can precede the previous performance.now(); never let dt go negative
  const dt =
    lastFrameAt === null ? 0 : Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - lastFrameAt) / 1000));
  lastFrameAt = now;
  const time = now / 1000;
  const frame: BlobFrame = { time, dt, mix: blobColorMix(time) };
  for (const listener of listeners) listener(frame);
  schedule();
}

function schedule(): void {
  if (frameId !== null || listeners.size === 0 || pageHidden()) return;
  frameId = requestAnimationFrame(runFrame);
}

function stop(): void {
  if (frameId !== null) cancelAnimationFrame(frameId);
  frameId = null;
  lastFrameAt = null;
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => (pageHidden() ? stop() : schedule()));
}

/** Joins the single animation loop shared by every loader; the loop stops when nobody listens. */
export function subscribeBlobFrames(listener: FrameListener): () => void {
  bindVisibility();
  listeners.add(listener);
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

type VisibilityListener = (visible: boolean) => void;

const visibilityListeners = new WeakMap<Element, VisibilityListener>();
let sharedObserver: IntersectionObserver | null = null;

function observer(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) visibilityListeners.get(entry.target)?.(entry.isIntersecting);
  });
  return sharedObserver;
}

/** Reports whether a loader is on screen, through one observer shared by all loaders. */
export function observeBlobVisibility(element: Element, listener: VisibilityListener): () => void {
  const shared = observer();
  if (shared === null) {
    listener(true);
    return () => {};
  }
  visibilityListeners.set(element, listener);
  shared.observe(element);
  return () => {
    shared.unobserve(element);
    visibilityListeners.delete(element);
  };
}
