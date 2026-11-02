import type { Terminal } from "@xterm/headless";

/** Xterm can retain a growing combined-cell string; cap contributions BEFORE parser allocation. */
export function makeRecoveryCombinationAdmission(terminal: Terminal): (data: string) => boolean {
  const service = (
    terminal as unknown as { _core: { unicodeService: { wcwidth(codepoint: number): number } } }
  )._core?.unicodeService;
  if (typeof service?.wcwidth !== "function")
    throw new Error("Unsupported Unicode admission profile");
  let contributions = 0;
  return (data) => {
    for (const char of data) {
      const point = char.codePointAt(0)!;
      // ASCII controls are not combined glyphs. Use the actual shared Unicode provider for
      // non-ASCII zero-width characters, including Hangul medial jamo (not Unicode marks).
      if (point > 127 && (service.wcwidth(point) === 0 || (point >= 0x1f3fb && point <= 0x1f3ff))) {
        if (++contributions > 1024) return false;
      }
    }
    return true;
  };
}
