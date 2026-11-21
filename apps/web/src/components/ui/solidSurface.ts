/*
 * Solid surfaces stay opaque in every window material. Toasts, the search and command palettes,
 * dialogs, sheets and full-screen modals cover live content, and a translucent fill lets that
 * content show through their text. They paint the opaque palette (`--*-solid` in `index.css`)
 * instead of the theme tokens that `index.windowMaterial.css` tints.
 */

/** Floating surfaces: toasts, palettes, dialog, alert dialog, command dialog and sheet popups. */
export const SOLID_FLOATING_SURFACE_CLASS_NAME = "bg-(--popover-solid)";

/** Full-window modal surfaces that repaint the page tone, and the expanded image backing. */
export const SOLID_PAGE_SURFACE_CLASS_NAME = "bg-(--background-solid)";
