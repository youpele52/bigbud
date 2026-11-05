import * as Crypto from "node:crypto";
import * as FS from "node:fs";

import {
  CUA_CURSOR_THEME_ID,
  cuaDriverCursorThemePath,
  cuaDriverHonoursCursorTheme,
} from "@bigbud/shared/cua-driver/cursorTheme";

import { writeFileAtomically } from "./cuaDriver.atomicFile";
import {
  CUA_CURSOR_THEME_ARTIFACT_BASE64,
  CUA_CURSOR_THEME_ARTIFACT_SHA256,
} from "./cuaDriver.cursorTheme.artifact";

function isInstalled(target: string, bytes: Buffer): boolean {
  try {
    // The Driver refuses symlinked themes, so only a regular file counts.
    const stat = FS.lstatSync(target);
    return stat.isFile() && stat.size === bytes.length && FS.readFileSync(target).equals(bytes);
  } catch {
    return false;
  }
}

/**
 * Installs bigbud's agent cursor (the in-app browser's cursor, compiled for the
 * Driver overlay) into the private theme store the Driver reads through
 * `CUA_DRIVER_CURSOR_THEME_DIR`. Installing is the Driver's own atomic copy
 * of the compiled artifact, so no authoring sidecar is needed at runtime.
 *
 * Returns the id to pass as `serve --cursor-theme`, or `null` to keep the
 * Driver's default cursor: the theme is cosmetic and must never block Computer
 * Use from starting.
 */
export function prepareCuaCursorTheme(stateHome: string, version: string | null): string | null {
  if (!cuaDriverHonoursCursorTheme(version)) return null;
  try {
    const bytes = Buffer.from(CUA_CURSOR_THEME_ARTIFACT_BASE64, "base64");
    const digest = Crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== CUA_CURSOR_THEME_ARTIFACT_SHA256) {
      throw new Error("embedded cursor theme does not match its pinned digest");
    }
    const target = cuaDriverCursorThemePath(stateHome);
    // Renaming over a stale file or symlink replaces it without a missing-file window.
    if (!isInstalled(target, bytes)) writeFileAtomically(target, bytes, 0o600);
    return CUA_CURSOR_THEME_ID;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[desktop] cua-driver cursor theme unavailable, using the default: ${message}`);
    return null;
  }
}
