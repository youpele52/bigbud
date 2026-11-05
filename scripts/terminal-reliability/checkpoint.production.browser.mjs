import { Terminal } from "@xterm/xterm";
import { attachTerminalAddons } from "../../apps/web/src/components/terminal/TerminalViewport.addons.ts";
import {
  imageAddonLoader,
  buildInlineImageAddonOptions,
} from "../../apps/web/src/components/terminal/terminalLazyAddons.ts";
import {
  captureProductionState,
  restoreProductionState,
  parserProfile,
} from "./checkpoint.production.state.mjs";
import { captureBrowserPalette, restoreBrowserPalette } from "./checkpoint.production.palette.mjs";
import { productionOracle } from "./checkpoint.production.fixtures.mjs";

const write = (terminal, data) =>
  new Promise((resolve) =>
    terminal.write(Array.isArray(data) ? Uint8Array.from(data) : data, resolve),
  );
const options = { cols: 20, rows: 6, scrollback: 5000, cursorBlink: true, allowProposedApi: true };

function create() {
  const terminal = new Terminal(options);
  const mount = document.createElement("div");
  // Open detached, establishing browser services without displaying a partially imported frame.
  terminal.open(mount);
  const addons = attachTerminalAddons(terminal, { onGlyphShapingChanged: () => undefined });
  const replies = [];
  terminal.onData((data) => replies.push(data));
  return {
    terminal,
    replies,
    dispose() {
      addons.dispose();
      terminal.dispose();
      mount.remove();
    },
  };
}

globalThis.__productionCheckpoint = {
  async refusals() {
    const instance = create();
    let image;
    try {
      const profile = parserProfile(instance.terminal._core);
      const ImageAddon = await imageAddonLoader.load();
      if (!ImageAddon) throw new Error("image addon fixture unavailable");
      image = new ImageAddon(buildInlineImageAddonOptions());
      instance.terminal.loadAddon(image);
      let refused = false;
      try {
        captureProductionState(instance.terminal, profile);
      } catch (error) {
        refused = error.message === "unqualified parser/Unicode profile";
      }
      if (!refused) throw new Error("image-enabled profile was not refused");
      return { imageProfileRefused: true };
    } finally {
      image?.dispose();
      instance.dispose();
    }
  },
  seed() {
    const instance = create();
    try {
      return captureBrowserPalette(instance.terminal).base;
    } finally {
      instance.dispose();
    }
  },
  async run({ fixture, checkpoint, palette, expected }) {
    const source = create();
    const restored = create();
    try {
      const profile = parserProfile(restored.terminal._core);
      await write(source.terminal, fixture.prefix);
      restoreProductionState(restored.terminal, checkpoint, profile);
      restoreBrowserPalette(restored.terminal, palette);
      if (restored.replies.length) throw new Error("historical replies during import");
      source.replies.length = 0;
      await write(source.terminal, fixture.suffix);
      await write(restored.terminal, fixture.suffix);
      const result = {
        state: productionOracle(restored.terminal),
        replies: restored.replies.slice(),
        palette: captureBrowserPalette(restored.terminal),
      };
      const uninterrupted = {
        state: productionOracle(source.terminal),
        replies: source.replies.slice(),
        palette: captureBrowserPalette(source.terminal),
      };
      if (JSON.stringify(result) !== JSON.stringify(uninterrupted))
        throw new Error(`browser continuation mismatch: ${fixture.name}`);
      if (JSON.stringify(result) !== JSON.stringify(expected))
        throw new Error(`headless/browser continuation mismatch: ${fixture.name}`);
      // Exercise restored marker subscriptions and saved/reflow state after continuation.
      source.terminal.resize(17, 8);
      restored.terminal.resize(17, 8);
      await write(source.terminal, "\r\nresize\x1b[6n");
      await write(restored.terminal, "\r\nresize\x1b[6n");
      if (
        JSON.stringify(productionOracle(source.terminal)) !==
        JSON.stringify(productionOracle(restored.terminal))
      )
        throw new Error(`browser resize mismatch: ${fixture.name}`);
      const before = restored.replies.length;
      for (const instance of [source, restored]) {
        instance.terminal.textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowUp",
            code: "ArrowUp",
            keyCode: 38,
            bubbles: true,
          }),
        );
        instance.terminal.paste("paste");
      }
      if (
        restored.replies.length !== before + 2 ||
        JSON.stringify(source.replies) !== JSON.stringify(restored.replies)
      )
        throw new Error(
          `restored keyboard/paste mismatch: ${fixture.name}; before=${before}; source=${JSON.stringify(source.replies)}; restored=${JSON.stringify(restored.replies)}`,
        );
      // A second fresh browser target exercises browser -> browser recapture as well.
      const third = create();
      try {
        third.terminal.resize(17, 8);
        restoreProductionState(
          third.terminal,
          captureProductionState(restored.terminal, profile),
          profile,
        );
        restoreBrowserPalette(third.terminal, captureBrowserPalette(restored.terminal));
        if (third.replies.length) throw new Error("browser roundtrip emitted historical replies");
        await write(restored.terminal, "\r\nroundtrip");
        await write(third.terminal, "\r\nroundtrip");
        if (
          JSON.stringify(productionOracle(restored.terminal)) !==
          JSON.stringify(productionOracle(third.terminal))
        )
          throw new Error(`browser roundtrip mismatch: ${fixture.name}`);
      } finally {
        third.dispose();
      }
      return { name: fixture.name, browserRoundTrip: true, keyboardAndPaste: true };
    } finally {
      source.dispose();
      restored.dispose();
    }
  },
};
