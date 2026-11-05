import type { Terminal } from "@xterm/headless";

type ColorEvent = { type: number; index?: number; color?: [number, number, number] };
interface SnapshotCore {
  mouseStateService: { activeEncoding: string };
  _inputHandler: { onColor(callback: (events: ColorEvent[]) => void): { dispose(): void } };
  _oscLinkService: { _dataByLinkId: Map<number, unknown> };
}

/** Read-only pinned compatibility boundary; no private-state import and no query reply sink. */
export function attachRecoverySupplements(
  terminal: Terminal,
  colorQuery: (prefix: string) => void = () => undefined,
) {
  const core = (terminal as unknown as { _core: SnapshotCore })._core;
  if (!core?._inputHandler?.onColor || !core.mouseStateService || !core._oscLinkService)
    throw new Error("Unsupported headless supplement profile");
  const colors = new Map<number, string>();
  const listener = core._inputHandler.onColor((events) => {
    for (const event of events) {
      if (event.type === 0) {
        if (event.index !== undefined)
          colorQuery(`\x1b]${event.index < 256 ? `4;${event.index}` : event.index - 246};`);
        continue; // Queries belong to the frontend, never to the mirror.
      }
      if (event.type === 1 && event.index !== undefined && event.color) {
        colors.set(
          event.index,
          `#${event.color.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        );
      } else if (event.type === 2) {
        if (event.index !== undefined) colors.delete(event.index);
        else for (let index = 0; index < 256; index++) colors.delete(index);
      }
    }
  });
  return {
    capture(): { ansi: string; unsupported: string | null } {
      // The stock serialize addon silently drops OSC8. Refuse until range restoration qualifies.
      if (core._oscLinkService._dataByLinkId.size > 0)
        return { ansi: "", unsupported: "hyperlink-ranges-not-qualified" };
      const encoding = core.mouseStateService.activeEncoding;
      if (!["DEFAULT", "SGR", "SGR_PIXELS"].includes(encoding))
        return { ansi: "", unsupported: "mouse-encoding-not-qualified" };
      let ansi =
        encoding === "SGR_PIXELS"
          ? "\x1b[?1016h"
          : encoding === "SGR"
            ? "\x1b[?1006h"
            : "\x1b[?1006l";
      for (const [index, value] of colors)
        ansi += `\x1b]${index < 256 ? `4;${index}` : index - 246};${value}\x1b\\`;
      return { ansi, unsupported: null };
    },
    dispose() {
      listener.dispose();
    },
  };
}
