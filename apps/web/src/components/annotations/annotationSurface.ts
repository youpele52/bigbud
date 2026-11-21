/*
 * Annotation surfaces stay opaque in every window material. They sit over or beside code, page
 * and conversation content, and a translucent fill lets that content show through the comment
 * text. They paint the opaque palette (`--*-solid` in `index.css`) instead of the theme tokens
 * that `index.windowMaterial.css` tints.
 */

/** Annotation panels and cards: the "Comment on selection" composer, popovers, saved cards. */
export const ANNOTATION_PANEL_SURFACE_CLASS_NAME = "bg-(--card-solid)";

/** Inline annotation chips and the summary rows that list annotations. */
export const ANNOTATION_CHIP_SURFACE_CLASS_NAME = "bg-(--background-solid)";
