import "../../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BigbudLogo } from "../../sidebar/SidebarProjectItem";
import { ChatGreeting } from "./ChatGreeting";

describe("new-chat greeting production layout", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.classList.remove("dark");
  });

  it.each([
    ["light", 640, 400],
    ["dark", 640, 400],
    ["light", 320, 360],
    ["dark", 320, 360],
  ] as const)(
    "matches the original 32px logo in both states and uses a 24px thin greeting in %s at %spx",
    async (theme, width, height) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      const host = document.createElement("div");
      host.style.width = `${width}px`;
      host.style.height = `${height}px`;
      document.body.append(host);
      const screen = await render(
        <div className="flex h-full items-center justify-center">
          <BigbudLogo className="h-8 opacity-70" />
        </div>,
        { container: host },
      );
      const baselineLogo = host.querySelector("svg")!;
      const baselineBox = baselineLogo.getBoundingClientRect();
      const baselineViewBox = baselineLogo.getAttribute("viewBox");
      const baselineAspectRatio = baselineLogo.getAttribute("preserveAspectRatio");
      expect(baselineBox.width).toBe(32);
      expect(baselineBox.height).toBe(32);
      expect(baselineViewBox).toBe("-167.83 0 1609.12 1609.12");
      await screen.rerender(<ChatGreeting />);
      const logoOnly = host.querySelector("svg")!;
      const logoOnlyBox = logoOnly.getBoundingClientRect();
      expect(logoOnlyBox.width).toBe(baselineBox.width);
      expect(logoOnlyBox.height).toBe(baselineBox.height);

      await screen.rerender(<ChatGreeting greeting="What’s up next, Youpele?" />);
      const logo = host.querySelector("svg")!;
      const greeting = host.querySelector("p")!;
      const logoBox = logo.getBoundingClientRect();
      const greetingBox = greeting.getBoundingClientRect();
      expect(logoBox.width).toBe(logoOnlyBox.width);
      expect(logoBox.height).toBe(logoOnlyBox.height);
      expect(logo.getAttribute("viewBox")).toBe(baselineViewBox);
      expect(logoOnly.getAttribute("viewBox")).toBe(baselineViewBox);
      expect(logo.getAttribute("preserveAspectRatio")).toBe(baselineAspectRatio);
      expect(logoOnly.getAttribute("preserveAspectRatio")).toBe(baselineAspectRatio);
      expect(getComputedStyle(logo).flexShrink).toBe("0");
      expect(getComputedStyle(logoOnly).flexShrink).toBe("0");
      expect(logoBox.top).toBe(logoOnlyBox.top);
      expect(logoBox.left).toBe(logoOnlyBox.left);
      expect(logoBox.top + 16 - host.getBoundingClientRect().top).toBeCloseTo(height / 2, 0);
      expect(
        greetingBox.top + parseFloat(getComputedStyle(greeting).paddingTop) - logoBox.bottom,
      ).toBe(28);
      expect(getComputedStyle(greeting).fontSize).toBe("24px");
      expect(getComputedStyle(greeting).fontWeight).toBe("100");
      expect(getComputedStyle(greeting).fontFamily).toBe(
        getComputedStyle(document.body).fontFamily,
      );
      await screen.unmount();
    },
  );

  it("wraps a long nickname in a short narrow conversational area without overlapping the bottom composer", async () => {
    const host = document.createElement("div");
    host.style.width = "240px";
    host.style.height = "260px";
    document.body.append(host);
    await render(
      <div className="flex h-full min-h-0 flex-col">
        <div data-conversation className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <ChatGreeting greeting={`Good morning, ${"小".repeat(64)}. What’s on your mind?`} />
        </div>
        <div data-composer className="h-20 shrink-0">
          Composer
        </div>
      </div>,
      { container: host },
    );
    const conversation = host.querySelector<HTMLElement>("[data-conversation]")!;
    const composer = host.querySelector<HTMLElement>("[data-composer]")!;
    const logo = host.querySelector("svg")!;
    const greeting = host.querySelector("p")!;
    expect(logo.getBoundingClientRect().width).toBe(32);
    expect(logo.getBoundingClientRect().height).toBe(32);
    expect(getComputedStyle(logo).flexShrink).toBe("0");
    expect(getComputedStyle(greeting).fontSize).toBe("24px");
    expect(getComputedStyle(greeting).fontWeight).toBe("100");
    expect(greeting.getBoundingClientRect().height).toBeGreaterThan(60);
    expect(greeting.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      logo.getBoundingClientRect().bottom,
    );
    expect(conversation.scrollWidth).toBe(conversation.clientWidth);
    expect(getComputedStyle(conversation).overflowY).toBe("auto");
    expect(composer.getBoundingClientRect().top).toBe(conversation.getBoundingClientRect().bottom);
    expect(composer.getBoundingClientRect().bottom).toBe(host.getBoundingClientRect().bottom);
  });

  it("shimmers the logo and message together for one pass", async () => {
    const host = document.createElement("div");
    host.style.width = "640px";
    host.style.height = "400px";
    document.body.append(host);
    const screen = await render(<ChatGreeting greeting="What’s up next, Youpele?" shimmer />, {
      container: host,
    });
    const logo = host.querySelector("svg")!;
    const greeting = host.querySelector("p")!;
    expect(getComputedStyle(logo).animationName).toBe("chat-greeting-mark-shimmer");
    expect(getComputedStyle(logo).animationDuration).toBe("2s");
    expect(getComputedStyle(logo).animationIterationCount).toBe("1");
    expect(
      greeting.getAnimations().map((animation) => (animation as CSSAnimation).animationName),
    ).toEqual(["tw-shimmer", "chat-greeting-message-glint"]);
    expect(getComputedStyle(greeting).animationDuration).toBe("2s, 2s");
    expect(getComputedStyle(greeting).animationIterationCount).toBe("1, 1");
    await screen.unmount();
  });
});
