import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import type { TerminalLigatures } from "@bigbud/contracts/core/settings.terminal.ts";
import {
  imageAddonLoader,
  ligaturesAddonLoader,
  buildInlineImageAddonOptions,
} from "./terminalLazyAddons";
import type { LazyAddonLoader } from "./terminalLazyAddons";
import { resolveTerminalLigaturesEnabled } from "./terminalLigatures";
import { activateTerminalUnicodeProvider } from "./terminalUnicodeProvider";
import { normalizeTerminalTuiMouseWheelMultiplier } from "./terminalTuiWheel";

/** Interaction preferences applied live, without recreating the emulator or its PTY. */
export interface TerminalInteractionSettings {
  readonly terminalScrollSensitivity: number;
  readonly terminalFastScrollSensitivity: number;
  readonly terminalTuiScrollSensitivity: number;
  readonly terminalLigatures: TerminalLigatures;
  readonly terminalInlineImages: boolean;
}

export function pickTerminalInteractionSettings(
  settings: TerminalInteractionSettings,
): TerminalInteractionSettings {
  return {
    terminalScrollSensitivity: settings.terminalScrollSensitivity,
    terminalFastScrollSensitivity: settings.terminalFastScrollSensitivity,
    terminalTuiScrollSensitivity: settings.terminalTuiScrollSensitivity,
    terminalLigatures: settings.terminalLigatures,
    terminalInlineImages: settings.terminalInlineImages,
  };
}

function disposeQuietly(addon: ITerminalAddon): void {
  try {
    addon.dispose();
  } catch {
    /* Addon teardown never takes the emulator down with it. */
  }
}

/** One optional addon: loaded on demand, attached while wanted, disposed when switched off. */
function optionalAddon<T>(
  terminal: Terminal,
  loader: LazyAddonLoader<T>,
  create: (constructor: T) => ITerminalAddon,
  onChanged: () => void,
) {
  let addon: ITerminalAddon | null = null;
  let wanted = false;
  let disposed = false;
  return {
    set(enabled: boolean) {
      wanted = enabled && !disposed;
      if (!wanted) {
        if (addon) {
          disposeQuietly(addon);
          addon = null;
          onChanged();
        }
        return;
      }
      if (addon) return;
      void loader.load().then((constructor) => {
        if (disposed || !wanted || addon || !constructor) return;
        const next = create(constructor);
        try {
          terminal.loadAddon(next);
        } catch {
          disposeQuietly(next);
          return;
        }
        addon = next;
        onChanged();
      });
    },
    dispose() {
      disposed = true;
      wanted = false;
      if (addon) disposeQuietly(addon);
      addon = null;
    },
  };
}

/**
 * xterm addons beyond fit/WebGL: Unicode 11 widths with the ZWJ shim (before any write), search,
 * and the lazily loaded ligature and inline image addons. Ligatures change glyph shaping, so an
 * attached WebGL renderer must rebuild its atlas (`onGlyphShapingChanged`).
 */
export function attachTerminalAddons(
  terminal: Terminal,
  options: { readonly onGlyphShapingChanged: () => void },
) {
  terminal.loadAddon(new Unicode11Addon());
  activateTerminalUnicodeProvider(terminal as never);
  const search = new SearchAddon({ highlightLimit: 1_000 });
  terminal.loadAddon(search);
  const ligatures = optionalAddon(
    terminal,
    ligaturesAddonLoader,
    (Addon) => new Addon(),
    options.onGlyphShapingChanged,
  );
  const images = optionalAddon(
    terminal,
    imageAddonLoader,
    (Addon) => new Addon(buildInlineImageAddonOptions()),
    () => undefined,
  );
  let tuiWheelMultiplier = 1;
  return {
    search,
    tuiWheelMultiplier: () => tuiWheelMultiplier,
    update(settings: TerminalInteractionSettings, fontFamily: string) {
      if (terminal.options.scrollSensitivity !== settings.terminalScrollSensitivity)
        terminal.options.scrollSensitivity = settings.terminalScrollSensitivity;
      if (terminal.options.fastScrollSensitivity !== settings.terminalFastScrollSensitivity)
        terminal.options.fastScrollSensitivity = settings.terminalFastScrollSensitivity;
      tuiWheelMultiplier = normalizeTerminalTuiMouseWheelMultiplier(
        settings.terminalTuiScrollSensitivity,
      );
      ligatures.set(resolveTerminalLigaturesEnabled(settings.terminalLigatures, fontFamily));
      images.set(settings.terminalInlineImages);
    },
    dispose() {
      ligatures.dispose();
      images.dispose();
    },
  };
}

export type TerminalAddons = ReturnType<typeof attachTerminalAddons>;
