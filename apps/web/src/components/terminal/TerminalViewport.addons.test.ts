import { beforeEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => {
  const make = () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((done) => (resolve = done));
    return { load: vi.fn(() => promise), resolve: (value: unknown) => resolve(value) };
  };
  return { ligatures: make(), images: make() };
});
vi.mock("./terminalLazyAddons", () => ({
  ligaturesAddonLoader: loaders.ligatures,
  imageAddonLoader: loaders.images,
  buildInlineImageAddonOptions: () => ({ storageLimit: 32 }),
}));

import { attachTerminalAddons, type TerminalInteractionSettings } from "./TerminalViewport.addons";

class FakeAddon {
  static created: FakeAddon[] = [];
  readonly dispose = vi.fn();
  constructor(readonly options?: unknown) {
    FakeAddon.created.push(this);
  }
  activate() {}
}

const settings: TerminalInteractionSettings = {
  terminalScrollSensitivity: 2,
  terminalFastScrollSensitivity: 7,
  terminalTuiScrollSensitivity: 3,
  terminalLigatures: "auto",
  terminalInlineImages: false,
};

function fakeTerminal() {
  return {
    options: { scrollSensitivity: 1, fastScrollSensitivity: 5 } as Record<string, unknown>,
    loadAddon: vi.fn(),
    unicode: { activeVersion: "6", versions: ["6", "11"], register: vi.fn() },
  };
}

const flush = async () => {
  for (let index = 0; index < 4; index++) await Promise.resolve();
};

describe("attachTerminalAddons", () => {
  beforeEach(() => {
    FakeAddon.created = [];
    loaders.ligatures.resolve(FakeAddon);
    loaders.images.resolve(FakeAddon);
  });

  it("activates Unicode 11 widths and search before any write, and applies scroll settings", () => {
    const terminal = fakeTerminal();
    const addons = attachTerminalAddons(terminal as never, { onGlyphShapingChanged: vi.fn() });
    expect(terminal.loadAddon).toHaveBeenCalledTimes(2);
    expect(terminal.unicode.activeVersion).toBe("11");
    addons.update(settings, "Menlo");
    expect(terminal.options.scrollSensitivity).toBe(2);
    expect(terminal.options.fastScrollSensitivity).toBe(7);
    expect(addons.tuiWheelMultiplier()).toBe(3);
    addons.dispose();
  });

  it("loads ligatures for ligature fonts in auto mode and rebuilds WebGL on every change", async () => {
    const terminal = fakeTerminal();
    const onGlyphShapingChanged = vi.fn();
    const addons = attachTerminalAddons(terminal as never, { onGlyphShapingChanged });
    addons.update(settings, "Menlo");
    await flush();
    expect(FakeAddon.created).toHaveLength(0);
    addons.update(settings, '"JetBrains Mono Nerd Font Mono", monospace');
    await flush();
    expect(FakeAddon.created).toHaveLength(1);
    expect(onGlyphShapingChanged).toHaveBeenCalledOnce();
    addons.update({ ...settings, terminalLigatures: "off" }, "JetBrains Mono");
    expect(FakeAddon.created[0]!.dispose).toHaveBeenCalledOnce();
    expect(onGlyphShapingChanged).toHaveBeenCalledTimes(2);
    addons.dispose();
  });

  it("attaches inline images with bounded options and never after dispose", async () => {
    const terminal = fakeTerminal();
    const addons = attachTerminalAddons(terminal as never, { onGlyphShapingChanged: vi.fn() });
    addons.update({ ...settings, terminalLigatures: "off", terminalInlineImages: true }, "Menlo");
    await flush();
    expect(FakeAddon.created[0]!.options).toEqual({ storageLimit: 32 });
    addons.update({ ...settings, terminalLigatures: "off", terminalInlineImages: false }, "Menlo");
    expect(FakeAddon.created[0]!.dispose).toHaveBeenCalledOnce();
    addons.update({ ...settings, terminalLigatures: "off", terminalInlineImages: true }, "Menlo");
    addons.dispose();
    await flush();
    expect(FakeAddon.created).toHaveLength(1);
  });

  it("contains an addon that fails to attach", async () => {
    const terminal = fakeTerminal();
    const addons = attachTerminalAddons(terminal as never, { onGlyphShapingChanged: vi.fn() });
    terminal.loadAddon.mockImplementation(() => {
      throw new Error("unsupported");
    });
    addons.update({ ...settings, terminalLigatures: "on" }, "Menlo");
    await flush();
    expect(FakeAddon.created[0]!.dispose).toHaveBeenCalledOnce();
    addons.dispose();
  });
});
