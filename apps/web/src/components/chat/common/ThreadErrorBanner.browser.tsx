import "../../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

const error =
  "V2 project has saved native approvals that can bypass bigbud access modes. Review them in OpenCode before starting work; bigbud never deletes user approvals automatically.";

afterEach(() => {
  document.body.innerHTML = "";
  useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
  vi.restoreAllMocks();
});

it("closes native approval errors for this session only without changing the error", async () => {
  const write = vi.spyOn(Storage.prototype, "setItem");
  const props = Object.freeze({
    threadId: "approvals-one",
    error,
    provider: "opencodeV2",
  });
  const screen = await render(<ThreadErrorBanner {...props} />);
  await expect.element(page.getByText(error)).toBeVisible();
  const close = page.getByRole("button", { name: "Dismiss error" });
  (close.element() as HTMLButtonElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(props.error).toBe(error);
  expect(write).toHaveBeenCalled();
  expect([...useThreadNoticeDismissalStore.getState().dismissed].join()).not.toContain(error);
  await screen.unmount();
  const reopened = await render(<ThreadErrorBanner {...props} />);
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await reopened.rerender(<ThreadErrorBanner {...props} threadId="approvals-two" />);
  await expect.element(page.getByText(error)).toBeVisible();
  await reopened.rerender(<ThreadErrorBanner {...props} error="Changed approval condition" />);
  await expect.element(page.getByText("Changed approval condition")).not.toBeInTheDocument();
  await reopened.rerender(<ThreadErrorBanner {...props} provider="codex" />);
  await expect.element(page.getByText(error)).toBeVisible();
  // A new app run clears shared dismissal state (store lifecycle tested separately).
  useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
  await reopened.rerender(<ThreadErrorBanner {...props} />);
  await expect.element(page.getByText(error)).toBeVisible();
});
