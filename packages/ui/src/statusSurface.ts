export type StatusSurfaceTone = "default" | "info" | "loading" | "success" | "warning" | "error";

const ACCENTS: Record<StatusSurfaceTone, string> = {
  // Thread idle uses muted-foreground. Keep it opaque so the neutral rail stays visible.
  default: "border-l-muted-foreground",
  info: "border-l-muted-foreground",
  loading: "border-l-info-foreground",
  success: "border-l-success",
  warning: "border-l-warning",
  error: "border-l-destructive",
};

export const STATUS_SURFACE_BACKGROUNDS: Record<StatusSurfaceTone, string> = {
  default: "bg-transparent dark:bg-input/32",
  info: "bg-transparent dark:bg-input/32",
  loading: "bg-info/4",
  success: "bg-success/4",
  warning: "bg-warning/4",
  error: "bg-destructive/4",
};

/** Shared banner/toast rail; untyped notifications are neutral information, never progress. */
export function statusSurfaceAccent(type?: string | null): string {
  const tone = type && Object.hasOwn(ACCENTS, type) ? (type as StatusSurfaceTone) : "default";
  return `border-l-2 ${ACCENTS[tone]}`;
}
