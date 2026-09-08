import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useBrowserPanelStore } from "~/stores/browser/browser.store";
import { waitForBrowserTabAgentHandler } from "./browserAgentControl";

const annotationHarness = vi.hoisted(() => {
  let pendingResolve: ((value: null) => void) | null = null;
  let pendingCancelResolve: (() => void) | null = null;
  let cancelError: Error | null = null;

  return {
    startAnnotation: vi.fn(
      () =>
        new Promise<null>((resolve) => {
          pendingResolve = resolve;
        }),
    ),
    cancelAnnotation: vi.fn(() => {
      pendingResolve?.(null);
      pendingResolve = null;
      if (cancelError) {
        return Promise.reject(cancelError);
      }
      if (pendingCancelResolve) {
        return new Promise<void>((resolve) => {
          pendingCancelResolve = resolve;
        });
      }
      return Promise.resolve();
    }),
    rejectCancellation(error: Error) {
      cancelError = error;
    },
    stallCancellation() {
      pendingCancelResolve = () => undefined;
    },
    resolvePending: (value: null) => {
      pendingResolve?.(value);
      pendingResolve = null;
    },
    reset() {
      pendingResolve = null;
      pendingCancelResolve = null;
      cancelError = null;
      this.startAnnotation.mockClear();
      this.cancelAnnotation.mockClear();
    },
  };
});

const browserHistoryStorageMock = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock("~/config/env", () => ({
  isElectron: true,
}));

vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: vi.fn(() => null),
  setLocalStorageItem: browserHistoryStorageMock.set,
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
      reloadIgnoringCache: () => undefined,
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
    browserHistoryStorageMock.set.mockClear();
    useBrowserPanelStore.setState({
      open: true,
      tabsById: {
        browser: { faviconUrl: null, title: "", url: "https://example.com" },
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    useBrowserPanelStore.setState({ open: false, tabsById: {} });
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

  it("cleans up annotation mode immediately while browser close cancellation is pending", async () => {
    annotationHarness.stallCancellation();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const annotateButton = await waitForAnnotateButton();
      annotateButton.click();
      await vi.waitFor(() => expect(annotateButton.dataset.pressed).toBe("true"));

      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close browser panel"]')
        ?.click();

      await vi.waitFor(() => {
        expect(annotationHarness.cancelAnnotation).toHaveBeenCalledTimes(1);
        expect(annotateButton.dataset.pressed).toBeUndefined();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("cleans up annotation mode when panel-hide cancellation fails", async () => {
    annotationHarness.rejectCancellation(new Error("Cancellation failed"));
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const annotateButton = await waitForAnnotateButton();
      annotateButton.click();
      await vi.waitFor(() => expect(annotateButton.dataset.pressed).toBe("true"));

      useBrowserPanelStore.setState({ open: false });

      await vi.waitFor(() => {
        expect(annotationHarness.cancelAnnotation).toHaveBeenCalledTimes(1);
        expect(annotateButton.dataset.pressed).toBeUndefined();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("cleans up annotation mode when its mounted tab becomes hidden", async () => {
    annotationHarness.stallCancellation();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} visible />, {
      container: host,
    });

    try {
      const annotateButton = await waitForAnnotateButton();
      annotateButton.click();
      await vi.waitFor(() => expect(annotateButton.dataset.pressed).toBe("true"));

      await screen.rerender(<BrowserPanel activeThreadId={"thread-1" as never} visible={false} />);

      await vi.waitFor(() => {
        expect(annotationHarness.cancelAnnotation).toHaveBeenCalledTimes(1);
        expect(annotateButton.dataset.pressed).toBeUndefined();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("recovers when second-click cancellation fails", async () => {
    annotationHarness.rejectCancellation(new Error("Cancellation failed"));
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const annotateButton = await waitForAnnotateButton();
      annotateButton.click();
      await vi.waitFor(() => expect(annotateButton.dataset.pressed).toBe("true"));

      annotateButton.click();

      await vi.waitFor(() => {
        expect(annotationHarness.cancelAnnotation).toHaveBeenCalledTimes(1);
        expect(annotateButton.dataset.pressed).toBeUndefined();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("registers its mounted tab for agent control", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      await expect(waitForBrowserTabAgentHandler("browser")).resolves.toEqual(
        expect.objectContaining({ execute: expect.any(Function) }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("submits resolved omnibox navigation without recording pre-commit history", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const input = document.querySelector('input[placeholder="Enter a URL or search"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Unable to find browser omnibox.");
      }
      await page.getByPlaceholder("Enter a URL or search").fill("example.com:443/docs");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      await vi.waitFor(() => {
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe(
          "https://example.com/docs",
        );
        expect(browserHistoryStorageMock.set).not.toHaveBeenCalled();
      });
    } finally {
      await screen.unmount();
    }
  });

  it("adds a bookmark from the accessible toolbar action", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      await page.getByRole("button", { name: "Add bookmark" }).click();

      await vi.waitFor(() => {
        expect(browserHistoryStorageMock.set).toHaveBeenCalledWith(
          "bigbud:browser-bookmarks:v1",
          expect.objectContaining({
            version: 1,
            bookmarks: [
              expect.objectContaining({
                url: "https://example.com/",
                title: "",
                createdAt: expect.any(String),
                updatedAt: expect.any(String),
              }),
            ],
          }),
          expect.anything(),
        );
      });
      await expect.element(page.getByRole("button", { name: "Remove bookmark" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
