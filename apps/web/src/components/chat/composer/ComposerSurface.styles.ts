/**
 * Presentation tokens shared by the desktop and mobile composer surfaces.
 *
 * Keep behavior, provider state, and responsive touch-size overrides in the
 * consuming components. These values describe only the floating composer
 * frame, prompt area, and footer layout.
 */
export const composerSurfaceStyles = {
  frame: "group rounded-[22px] p-px transition-colors duration-200",
  surface: "rounded-[20px] border bg-card transition-colors duration-200",
  surfaceFocus: "has-focus-visible:border-ring/45",
  surfaceDefaultBorder: "border-border",
  surfaceDragOver: "border-primary/70 bg-accent/30",
  input: {
    shell: "relative px-3 pb-2 sm:px-4",
    compact: "pt-2 pb-1.5",
    withHeader: "pt-2.5 sm:pt-3",
    withoutHeader: "pt-3.5 sm:pt-4",
  },
  footer: {
    shell:
      "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3",
    compact:
      "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2",
    compactGap: "gap-1.5",
    defaultGap: "gap-2 sm:gap-0",
  },
  footerLeading:
    "-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
} as const;
