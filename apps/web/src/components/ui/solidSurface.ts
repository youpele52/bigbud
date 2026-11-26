/*
 * Solid surfaces stay opaque in every window material. Toasts, the search and command palettes,
 * dialogs, sheets, menus, select and combobox lists, popovers, tooltips and full-screen modals
 * cover live content, and a translucent fill lets that content show through their text. They
 * paint the opaque palette (`--*-solid` in `index.css`) instead of the theme tokens that
 * `index.windowMaterial.css` tints.
 */

/** Floating surfaces: toasts, palettes, dialogs, sheets, menus, lists, popovers, tooltips and floating panels. */
export const SOLID_FLOATING_SURFACE_CLASS_NAME = "bg-(--popover-solid)";

/** Full-window modal surfaces that repaint the page tone, and the expanded image backing. */
export const SOLID_PAGE_SURFACE_CLASS_NAME = "bg-(--background-solid)";

/**
 * Modal backdrops (dialogs, alert dialogs, sheets, the command palette): a full-window dim plus a
 * light blur. Note: over a translucent window material Chromium composites a filtered backdrop
 * over the original, which can flatten the window to a solid tone while a modal is open (see
 * `index.windowMaterial.css`); the blur is a deliberate design choice under evaluation.
 */
export const MODAL_BACKDROP_CLASS_NAME = "fixed inset-0 z-50 bg-black/32 backdrop-blur-md";
