import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useBrowserPanelStore } from "~/stores/browser/browser.store";

const annotationHarness = vi.hoisted(() => {
  let pendingResolve: ((value: null) => void) | null = null;

  return {
    startAnnotation: vi.fn(
      () =>
        new Promise<null>((resolve) => {
          pendingResolve = resolve;
        }),
    ),
    cancelAnnotation: vi.fn(async () => {
      pendingResolve?.(null);
      pendingResolve = null;
    }),
    resolvePending: (value: null) => {
      pendingResolve?.(value);
      pendingResolve = null;
    },
    reset() {
      pendingResolve = null;
      this.startAnnotation.mockClear();
      this.cancelAnnotation.mockClear();
    },
  };
});

vi.mock("~/config/env", () => ({
  isElectron: true,
}));

vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: vi.fn(() => null),
  setLocalStorageItem: vi.fn(),
}));

vi.mock("~/stores/composer", () => ({
  useComposerDraftStore: (selector: (state: unknown) => unknown) =>
    selector({
      setPrompt: vi.fn(),
      addImage: vi.fn(),
    }),
}));

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: vi.fn(),
  },
}));

vi.mock("./BrowserPanel.viewport", async () => {
  const React = await import("react");

  const BrowserViewport = React.forwardRef(function MockBrowserViewport(
    _props: unknown,
    ref: React.ForwardedRef<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({
      goBack: () => undefined,
      goForward: () => undefined,
      reload: () => undefined,
      openDevTools: () => undefined,
      startAnnotation: annotationHarness.startAnnotation,
      cancelAnnotation: annotationHarness.cancelAnnotation,
    }));

    return <div data-testid="mock-browser-viewport" />;
  });

  return {
    BrowserViewport,
  };
});

import BrowserPanel from "./BrowserPanel";

async function waitForAnnotateButton(): Promise<HTMLButtonElement> {
  await vi.waitFor(() => {
    expect(document.querySelector('button[aria-label="Annotate browser page"]')).toBeTruthy();
  });

  const button = document.querySelector('button[aria-label="Annotate browser page"]');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Unable to find annotate browser page button.");
  }
  return button;
}

describe("BrowserPanel annotation UX", () => {
  beforeEach(() => {
    annotationHarness.reset();
    useBrowserPanelStore.setState({ open: true, url: "https://example.com" });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    useBrowserPanelStore.setState({ open: false, url: "" });
  });

  it("toggles annotation mode on click and cancels it on second click", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const annotateButton = await waitForAnnotateButton();

      annotateButton.click();

      await vi.waitFor(() => {
        expect(annotationHarness.startAnnotation).toHaveBeenCalledTimes(1);
        expect(annotateButton.className).toContain("text-info-foreground");
        expect(annotateButton.dataset.pressed).toBe("true");
      });

      annotateButton.click();

      await vi.waitFor(() => {
        expect(annotationHarness.cancelAnnotation).toHaveBeenCalledTimes(1);
        expect(annotateButton.className).not.toContain("text-info-foreground");
        expect(annotateButton.dataset.pressed).toBeUndefined();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("exits annotation mode when the viewport resolves a cancelled annotation", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const annotateButton = await waitForAnnotateButton();

      annotateButton.click();

      await vi.waitFor(() => {
        expect(annotateButton.dataset.pressed).toBe("true");
      });

      annotationHarness.resolvePending(null);

      await vi.waitFor(() => {
        expect(annotateButton.dataset.pressed).toBeUndefined();
        expect(annotateButton.className).not.toContain("text-info-foreground");
      });
    } finally {
      await screen.unmount();
    }
  });
});
