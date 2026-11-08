import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ChatTimestamp } from "./ChatTimestamp";
import { formatTimestamp } from "../../../utils/timestamp/timestamp.utils";

afterEach(() => vi.useRealTimers());

describe("ChatTimestamp calendar refresh", () => {
  it("updates idle labels at midnight without rerendering the chat body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const beforeMidnight = new Date(2026, 6, 5, 23, 59, 59);
    vi.setSystemTime(beforeMidnight);
    const createdAt = new Date(2026, 6, 5, 9, 8, 7).toISOString();
    const bodyRender = vi.fn();
    function ChatBody() {
      bodyRender();
      return (
        <div data-testid="timestamp">
          <ChatTimestamp createdAt={createdAt} timestampFormat="24-hour" />
        </div>
      );
    }
    const view = await render(<ChatBody />);
    await expect
      .element(page.getByTestId("timestamp"))
      .toHaveTextContent(formatTimestamp(createdAt, "24-hour", beforeMidnight));
    const initialRenders = bodyRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect
      .element(page.getByTestId("timestamp"))
      .toHaveTextContent(formatTimestamp(createdAt, "24-hour", new Date(2026, 6, 6)));
    expect(bodyRender).toHaveBeenCalledTimes(initialRenders);
    await view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches up multiple days after wake without another message or prop change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 11, 31, 12));
    const createdAt = new Date(2026, 11, 31, 9, 8, 7).toISOString();
    const view = await render(
      <div data-testid="timestamp">
        <ChatTimestamp createdAt={createdAt} timestampFormat="12-hour" />
      </div>,
    );
    vi.setSystemTime(new Date(2027, 0, 2, 12));
    window.dispatchEvent(new Event("focus"));
    await expect
      .element(page.getByTestId("timestamp"))
      .toHaveTextContent(formatTimestamp(createdAt, "12-hour", new Date(2027, 0, 2)));
    await view.unmount();
  });
});
