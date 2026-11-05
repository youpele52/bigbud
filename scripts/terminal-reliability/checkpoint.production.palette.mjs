// Effective RGB palette only. Presentation (selection, fonts, contrast caches) is view-local.
const rgb = (color) => color.rgba >>> 8;
const pack = ([r, g, b]) => (r << 16) | (g << 8) | b;
const slots = (colors) => [
  ...colors.ansi.map(rgb),
  rgb(colors.foreground),
  rgb(colors.background),
  rgb(colors.cursor),
];

function validate(palette) {
  if (
    !Array.isArray(palette) ||
    palette.length !== 259 ||
    palette.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffff)
  )
    throw new Error("invalid effective palette");
}

export function captureBrowserPalette(terminal) {
  const service = terminal._core._themeService;
  return { base: slots(service._restoreColors), current: slots(service.colors) };
}

function color(value) {
  return { css: `#${value.toString(16).padStart(6, "0")}`, rgba: ((value << 8) | 255) >>> 0 };
}

export function restoreBrowserPalette(terminal, state) {
  validate(state.base);
  validate(state.current);
  const service = terminal._core._themeService;
  const apply = (colors, values) => {
    colors.ansi = values.slice(0, 256).map(color);
    colors.foreground = color(values[256]);
    colors.background = color(values[257]);
    colors.cursor = color(values[258]);
  };
  // Silent, detached import: no historical query/theme-change notification is emitted.
  apply(service._restoreColors, state.base);
  apply(service._colors, state.current);
  service._contrastCache.clear();
  service._halfContrastCache.clear();
}

function report(index, value) {
  const ident = index < 256 ? `4;${index}` : String(index - 246);
  const channels = [value >>> 16, (value >>> 8) & 255, value & 255]
    .map((channel) => (channel * 257).toString(16).padStart(4, "0"))
    .join("/");
  return `\x1b]${ident};rgb:${channels}\x1b\\`;
}

// WCAG luminance, matching the pinned browser's color-scheme query semantics.
function luminance(value) {
  return [value >>> 16, (value >>> 8) & 255, value & 255].reduce((sum, byte, index) => {
    const channel = byte / 255;
    const linear = channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

/** Synthetic headless palette owner; the future runtime must serialize focus/theme operations. */
export function attachHeadlessPalette(terminal, initial) {
  validate(initial);
  let base = initial.slice();
  let current = initial.slice();
  let owner = null;
  const send = (data) => terminal._core.coreService.triggerDataEvent(data);
  const scheme = () =>
    send(`\x1b[?997;${luminance(current[257]) < luminance(current[256]) ? 1 : 2}n`);
  const changed = () => {
    if (terminal._core.coreService.decPrivateModes.colorSchemeUpdates) scheme();
  };
  const schemeListener = terminal._core._inputHandler.onRequestColorSchemeQuery(scheme);
  const listener = terminal._core._inputHandler.onColor((events) => {
    for (const event of events) {
      if (event.type === 0) send(report(event.index, current[event.index]));
      else if (event.type === 1) current[event.index] = pack(event.color);
      else if (event.index === undefined) current.splice(0, 256, ...base.slice(0, 256));
      else current[event.index] = base[event.index];
      if (event.type !== 0) changed();
    }
  });
  return {
    focus(view, palette) {
      validate(palette);
      owner = view;
      if (palette.some((value, index) => value !== base[index])) {
        base = palette.slice();
        current = palette.slice();
        changed();
      }
    },
    update(view, palette) {
      if (view !== owner) return false;
      validate(palette);
      base = palette.slice();
      current = palette.slice();
      changed();
      return true;
    },
    detach(view) {
      if (owner === view) owner = null;
    },
    capture: () => ({ base: base.slice(), current: current.slice() }),
    restore(state) {
      validate(state.base);
      validate(state.current);
      base = state.base.slice();
      current = state.current.slice();
      owner = null;
    },
    dispose() {
      listener.dispose();
      schemeListener.dispose();
    },
  };
}
