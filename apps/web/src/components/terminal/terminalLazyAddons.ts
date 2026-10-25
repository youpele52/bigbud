// Adapted from Orca (stablyai/orca, MIT) terminal-lazy-addon-loader.ts, terminal-image-addon-loader.ts
// and terminal-inline-image-options.ts at be4e0719.
import type { IImageAddonOptions, ImageAddon } from "@xterm/addon-image";
import type { TerminalLigaturesAddon } from "./terminalLigaturesAddon";

/** A gone chunk must not refetch on every attach, but one transient failure must not disable it. */
const ATTEMPT_LIMIT = 3;

export interface LazyAddonLoader<T> {
  /** The constructor, loading it on first use; null when loading failed. */
  load(): Promise<T | null>;
}

export function createLazyAddonLoader<T>(
  load: () => Promise<T>,
  label: string,
): LazyAddonLoader<T> {
  let loaded: T | null = null;
  let pending: Promise<T | null> | null = null;
  let attempts = 0;
  return {
    load() {
      if (loaded) return Promise.resolve(loaded);
      if (pending) return pending;
      if (attempts >= ATTEMPT_LIMIT) return Promise.resolve(null);
      attempts++;
      pending = load().then(
        (value) => {
          loaded = value;
          pending = null;
          return value;
        },
        (error: unknown) => {
          pending = null;
          console.warn(`[terminal] ${label} addon failed to load:`, error);
          return null;
        },
      );
      return pending;
    },
  };
}

type ImageAddonConstructor = new (options?: IImageAddonOptions) => ImageAddon;
type LigaturesAddonConstructor = new () => TerminalLigaturesAddon;

// Keep the import() specifiers literal so the bundler splits each addon into its own chunk.
export const imageAddonLoader = createLazyAddonLoader<ImageAddonConstructor>(
  () => import("@xterm/addon-image").then((module) => module.ImageAddon),
  "image",
);
export const ligaturesAddonLoader = createLazyAddonLoader<LigaturesAddonConstructor>(
  () => import("./terminalLigaturesAddon").then((module) => module.TerminalLigaturesAddon),
  "ligatures",
);

/** One encoded image sequence; bounds the decoder's working buffer (Orca: 8 MB). */
const IMAGE_SEQUENCE_SIZE_LIMIT = 8 * 1024 * 1024;
/** Decoded image cache per view before eviction, in MB of RGBA (Orca: 32). */
const IMAGE_STORAGE_LIMIT_MB = 32;

/**
 * Orca disables the addon's size reports because Orca answers CSI 14t/16t itself; bigbud has no
 * other responder, so the addon answers them (image tools size their output from the cell size).
 */
export function buildInlineImageAddonOptions(): IImageAddonOptions {
  return {
    enableSizeReports: true,
    storageLimit: IMAGE_STORAGE_LIMIT_MB,
    pixelLimit: (IMAGE_STORAGE_LIMIT_MB * 1_000_000) / 4,
    sixelSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    iipSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    kittySizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
  };
}
