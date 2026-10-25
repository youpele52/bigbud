import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { resolveTerminalTheme, resolveTerminalThemeHost } from "./terminalThemes";
import type { TerminalThemePreference } from "./terminalThemes";
import { attachTerminalRenderer } from "./TerminalViewport.rendering";
import { attachTerminalViewportInstrumentation } from "./TerminalViewport.instrumentation";
import { attachTerminalAddons, type TerminalInteractionSettings } from "./TerminalViewport.addons";
import { createTerminalOutputPipeline } from "./TerminalViewport.pipeline";
import { createTerminalWebLinkHandler } from "./TerminalViewport.links.web";
import { TerminalFontController, type TerminalTypographySettings } from "./TerminalFontController";
import { SYSTEM_TERMINAL_FONT_FAMILY } from "./terminalTypography";
import type { TerminalRendererState } from "./TerminalRendererController";
import type { TerminalGpuAcceleration } from "@bigbud/contracts/core/settings.ts";

export interface TerminalViewSettings
  extends TerminalTypographySettings, TerminalThemePreference, TerminalInteractionSettings {
  readonly terminalGpuAcceleration: TerminalGpuAcceleration;
  readonly visible: boolean;
}

/**
 * One xterm instance with everything that belongs to the view rather than to a delivery lane:
 * renderer, fonts, addons, instrumentation and the output pipeline hooks. Disposing it never
 * touches the PTY.
 */
export function createTerminalView(input: {
  readonly mount: HTMLElement;
  readonly settings: TerminalViewSettings;
  readonly threadId: string;
  readonly terminalId: string;
  readonly executionTargetId?: string | undefined;
  readonly onRendering: (state: TerminalRendererState) => void;
}) {
  const { mount, settings } = input;
  const fitAddon = new FitAddon();
  const terminal = new Terminal({
    cursorBlink: true,
    lineHeight: settings.terminalLineHeight,
    fontSize: settings.terminalFontSize,
    scrollback: 5_000,
    // The bundled family is applied only after loading, triggering real measurement.
    fontFamily: SYSTEM_TERMINAL_FONT_FAMILY,
    disableStdin: true,
    // Unicode 11 widths and search decorations use xterm's proposed API.
    allowProposedApi: true,
    scrollSensitivity: settings.terminalScrollSensitivity,
    fastScrollSensitivity: settings.terminalFastScrollSensitivity,
    theme: resolveTerminalTheme(settings, resolveTerminalThemeHost(mount)),
    linkHandler: createTerminalWebLinkHandler(),
  });
  terminal.loadAddon(fitAddon);
  terminal.open(mount);
  const instrumentation = attachTerminalViewportInstrumentation({
    terminal,
    threadId: input.threadId,
    terminalId: input.terminalId,
  });
  const renderer = attachTerminalRenderer(
    terminal,
    mount,
    (state) => {
      instrumentation.setRenderer(state);
      input.onRendering(state);
    },
    instrumentation.setForeground,
  );
  renderer.update(settings.terminalGpuAcceleration, settings.visible);
  // Addons load before the first write so cell widths are fixed from the first byte.
  const addons = attachTerminalAddons(terminal, { onGlyphShapingChanged: renderer.reattach });
  addons.update(settings, settings.terminalFontFamily);
  const fontController = new TerminalFontController(terminal);
  void fontController.update(settings);
  const pipeline = createTerminalOutputPipeline({
    terminal,
    executionTargetId: input.executionTargetId,
    isWebgl: instrumentation.isWebgl,
    lastInputAt: instrumentation.lastInputAt,
  });
  return {
    terminal,
    fitAddon,
    instrumentation,
    renderer,
    addons,
    fontController,
    pipeline,
    dispose() {
      pipeline.dispose();
      addons.dispose();
      renderer.dispose();
      instrumentation.dispose();
      fontController.dispose();
      terminal.dispose();
    },
  };
}

export type TerminalView = ReturnType<typeof createTerminalView>;
