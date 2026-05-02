import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserAnnotationCancelScript,
  browserAnnotationCleanupScript,
  browserAnnotationPrepareCaptureScript,
} from "./BrowserPanel.annotation";

type FakeListener = (event?: { type?: string }) => void;

class FakeElement {
  public id = "";
  public style: Record<string, string> = {};
  public removed = false;
  private readonly owner: FakeDocument;

  constructor(owner: FakeDocument) {
    this.owner = owner;
  }

  remove() {
    this.removed = true;
    if (this.id) {
      this.owner.elements.delete(this.id);
    }
  }
}

class FakeDocument {
  public readonly elements = new Map<string, FakeElement>();
  private readonly listeners = new Map<string, Set<FakeListener>>();

  getElementById(id: string) {
    return this.elements.get(id) ?? null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type?: string }) {
    if (!event.type) return true;
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }
}

describe("browser annotation helper scripts", () => {
  let fakeDocument: FakeDocument;

  beforeEach(() => {
    fakeDocument = new FakeDocument();
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal(
      "CustomEvent",
      class {
        type: string;

        constructor(type: string) {
          this.type = type;
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes the annotation root during cleanup", () => {
    const root = new FakeElement(fakeDocument);
    root.id = "__bigbud_annotation_root";
    fakeDocument.elements.set(root.id, root);

    browserAnnotationCleanupScript();

    expect(root.removed).toBe(true);
    expect(fakeDocument.getElementById("__bigbud_annotation_root")).toBeNull();
  });

  it("removes only the annotation panel before capture", async () => {
    const root = new FakeElement(fakeDocument);
    root.id = "__bigbud_annotation_root";
    fakeDocument.elements.set(root.id, root);

    const panel = new FakeElement(fakeDocument);
    panel.id = "__bigbud_annotation_panel";
    fakeDocument.elements.set(panel.id, panel);

    await browserAnnotationPrepareCaptureScript();

    expect(panel.removed).toBe(true);
    expect(fakeDocument.getElementById("__bigbud_annotation_root")).toBe(root);
  });

  it("dispatches the annotation cancel event", () => {
    const listener = vi.fn();
    fakeDocument.addEventListener("bigbud:browser-annotation-cancel", listener);

    browserAnnotationCancelScript();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
