import * as Path from "node:path";

import type { CuaDriverKnownVersion } from "./release";

/**
 * bigbud's agent cursor theme for the Driver overlay: the in-app browser's
 * agent cursor, compiled by `scripts/cua-cursor-theme/build.ts`. Bump the
 * version whenever the artwork changes.
 */
export const CUA_CURSOR_THEME_ID = "ai.bigbud.agent-cursor";
export const CUA_CURSOR_THEME_VERSION = "1.0.0";

/**
 * Whether `serve --cursor-theme` and `CUA_DRIVER_CURSOR_THEME_DIR` are honoured.
 * 0.38.0 resolves installed themes from that directory (cursor-overlay
 * `theme_artifact.rs` `theme_store_root`); 0.9.1 predates compiled themes.
 * Decided per pinnable version, so a new pin fails to compile until it is listed.
 */
const CURSOR_THEME_HONOURED: Readonly<Record<CuaDriverKnownVersion, boolean>> = {
  "0.9.1": false,
  "0.38.0": true,
};

export function cuaDriverHonoursCursorTheme(version: string | null | undefined): boolean {
  return (
    typeof version === "string" &&
    (CURSOR_THEME_HONOURED as Readonly<Record<string, boolean | undefined>>)[version] === true
  );
}

/** Theme store inside bigbud's private Driver state home, never the user-wide one. */
export function cuaDriverCursorThemeDirectory(stateHome: string): string {
  return Path.join(stateHome, "cursor-themes");
}

/** The Driver loads an installed theme only from `<store>/<id>.cua-theme`. */
export function cuaDriverCursorThemePath(stateHome: string): string {
  return Path.join(cuaDriverCursorThemeDirectory(stateHome), `${CUA_CURSOR_THEME_ID}.cua-theme`);
}
