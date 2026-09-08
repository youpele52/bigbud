export type MediaPreviewPhase = "loading" | "loaded" | "error";

export function getMediaPreviewPhase(input: {
  readonly url: string;
  readonly loadedUrl: string | null;
  readonly errorUrl: string | null;
}): MediaPreviewPhase {
  if (input.errorUrl === input.url) return "error";
  if (input.loadedUrl === input.url) return "loaded";
  return "loading";
}
