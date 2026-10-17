import type { Terminal } from "@xterm/xterm";
import { SYSTEM_TERMINAL_FONT_FAMILY } from "./terminalTypography";

export interface TerminalTypographySettings {
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  bundledTerminalFont: string | null;
}

type FontLoader = (family: string, size: number) => Promise<boolean>;

/** A missing or failed asset must not prevent the shell from starting. */
async function loadBundledTerminalFont(family: string, size: number): Promise<boolean> {
  if (typeof document === "undefined" || typeof document.fonts === "undefined") return false;
  try {
    const faces = await document.fonts.load(`${size}px "${family}"`);
    if (faces.length > 0) return true;
    console.warn(`[terminal] Font ${family} is unavailable; using system monospace.`);
  } catch (error) {
    console.warn(`[terminal] Failed to load ${family}; using system monospace.`, error);
  }
  return false;
}

/** Applies only loaded fonts so xterm never caches fallback metrics under a bundled family. */
export class TerminalFontController {
  private settings: TerminalTypographySettings | null = null;
  private revision = 0;
  private disposed = false;
  private ready: Promise<void> = Promise.resolve();
  private finishWait: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly terminal: Pick<Terminal, "options">,
    private readonly loadFont: FontLoader = loadBundledTerminalFont,
  ) {}

  onApplied(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits for the latest choice, bounded to one second per pending font load. */
  async whenReady(): Promise<void> {
    while (!this.disposed) {
      const ready = this.ready;
      await ready;
      if (ready === this.ready) return;
    }
  }

  update({
    terminalFontFamily,
    terminalFontSize,
    terminalLineHeight,
    bundledTerminalFont,
  }: TerminalTypographySettings): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const settings = {
      terminalFontFamily,
      terminalFontSize,
      terminalLineHeight,
      bundledTerminalFont,
    };
    if (
      this.settings?.terminalFontFamily === settings.terminalFontFamily &&
      this.settings.terminalFontSize === settings.terminalFontSize &&
      this.settings.terminalLineHeight === settings.terminalLineHeight &&
      this.settings.bundledTerminalFont === settings.bundledTerminalFont
    ) {
      return this.whenReady();
    }
    this.settings = settings;
    const revision = ++this.revision;
    this.finishWait?.();
    const apply = (loaded: boolean) => {
      if (this.disposed || revision !== this.revision) return;
      const fontFamily = loaded ? settings.terminalFontFamily : SYSTEM_TERMINAL_FONT_FAMILY;
      if (
        this.terminal.options.fontFamily === fontFamily &&
        this.terminal.options.fontSize === settings.terminalFontSize &&
        this.terminal.options.lineHeight === settings.terminalLineHeight
      )
        return;
      this.terminal.options.fontSize = settings.terminalFontSize;
      this.terminal.options.lineHeight = settings.terminalLineHeight;
      this.terminal.options.fontFamily = fontFamily;
      for (const listener of this.listeners) listener();
    };
    if (settings.bundledTerminalFont === null) {
      apply(true);
      this.ready = Promise.resolve();
      return this.ready;
    }

    this.ready = new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        apply(false);
        finish();
      }, 1_000);
      const finish = () => {
        window.clearTimeout(timer);
        if (this.finishWait === finish) this.finishWait = null;
        resolve();
      };
      this.finishWait = finish;
      // Keep observing after timeout: a late font load must remeasure and refit.
      void this.loadFont(settings.bundledTerminalFont!, settings.terminalFontSize).then(
        (loaded) => {
          apply(loaded);
          finish();
        },
      );
    });
    return this.whenReady();
  }

  dispose(): void {
    this.disposed = true;
    this.finishWait?.();
    this.listeners.clear();
  }
}
