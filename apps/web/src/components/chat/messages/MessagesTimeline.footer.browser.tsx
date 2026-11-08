import "../../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  createBaseTimelineProps,
  createMessage,
} from "./MessagesTimeline.virtualization.test.fixtures";
import { formatTimestamp } from "../../../utils/timestamp/timestamp.utils";

vi.mock("../common/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

afterEach(() => {
  document.body.innerHTML = "";
});

it.each(["user", "assistant"] as const)(
  "%s footer preserves its timestamp/action order on hover or keyboard focus, without layout shift",
  async (role) => {
    const message = createMessage({
      id: `${role}-footer`,
      role,
      text: `${role} body`,
      offsetSeconds: 0,
    });
    const onBranch = vi.fn();
    const props = createBaseTimelineProps({ messages: [message] });
    const view = await render(
      <div>
        <button type="button">Outside message</button>
        <MessagesTimeline {...props} scrollContainer={null} onBranchThread={onBranch} />
      </div>,
    );
    const footer = document.querySelector<HTMLElement>(`[data-message-footer="${role}"]`)!;
    expect(footer).not.toBeNull();
    // User: timestamp then icons. Assistant: icons then timestamp (and duration).
    const timestamp = role === "user" ? footer.firstElementChild! : footer.lastElementChild!;
    expect(timestamp.tagName).toBe("P");
    if (role === "assistant") expect(footer.firstElementChild!.tagName).not.toBe("P");
    expect(timestamp.textContent).toContain(formatTimestamp(message.createdAt, "locale"));
    expect(footer.querySelector("button")).not.toBeNull();
    // User timestamp is below, not inside, the bubble containing the message body.
    if (role === "user") {
      const bubble = footer.previousElementSibling!;
      expect(bubble.textContent).toContain("user body");
      expect(bubble.textContent).not.toContain(timestamp.textContent!);
    }
    await page.getByRole("button", { name: "Outside message" }).hover();
    await expect.poll(() => getComputedStyle(footer).opacity).toBe("0");
    const hiddenHeight = footer.offsetHeight;
    expect(hiddenHeight).toBeGreaterThan(0);
    await page.getByText(`${role} body`, { exact: true }).hover();
    await expect.poll(() => getComputedStyle(footer).opacity).toBe("1");
    expect(footer.offsetHeight).toBe(hiddenHeight);
    await page.getByRole("button", { name: "Outside message" }).hover();
    await expect.poll(() => getComputedStyle(footer).opacity).toBe("0");
    footer.querySelector("button")!.focus();
    await expect.poll(() => getComputedStyle(footer).opacity).toBe("1");
    await page.getByRole("button", { name: "Branch thread" }).click();
    expect(onBranch).toHaveBeenCalledExactlyOnceWith(message.id);
    await view.unmount();
  },
);

it.each(["user", "assistant"] as const)(
  "%s footer keeps old timestamps and actions inside a narrow chat column",
  async (role) => {
    const message = {
      ...createMessage({ id: `${role}-narrow`, role, text: "Narrow body", offsetSeconds: 0 }),
      createdAt: "2020-09-30T19:12:28.000Z",
    };
    const props = createBaseTimelineProps({ messages: [message] });
    const view = await render(
      <div style={{ width: 220 }}>
        <MessagesTimeline {...props} scrollContainer={null} onBranchThread={vi.fn()} />
      </div>,
    );
    const footer = document.querySelector<HTMLElement>(`[data-message-footer="${role}"]`)!;
    const row = footer.closest<HTMLElement>("[data-timeline-row-id]")!;
    const bounds = row.getBoundingClientRect();
    expect(footer.textContent).toContain(formatTimestamp(message.createdAt, "locale"));
    for (const child of footer.children) {
      const childBounds = child.getBoundingClientRect();
      expect(childBounds.left).toBeGreaterThanOrEqual(bounds.left);
      expect(childBounds.right).toBeLessThanOrEqual(bounds.right);
      expect(child.scrollWidth).toBeLessThanOrEqual(child.clientWidth);
    }
    await view.unmount();
  },
);
