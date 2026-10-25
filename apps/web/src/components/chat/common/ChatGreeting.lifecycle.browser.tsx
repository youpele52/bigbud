import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ ready: true, choice: vi.fn() }));
vi.mock("../../../rpc/serverState", () => ({ useServerConfig: () => (mocks.ready ? {} : null) }));
vi.mock("../../../utils/copy/greeting.logic", async (original) => ({
  ...(await original<typeof import("../../../utils/copy/greeting.logic")>()),
  greetingForChat: mocks.choice,
}));

import { createGreetingSelector } from "../../../utils/copy/greeting.logic";
import { useStore } from "../../../stores/main/main.store";
import { ChatGreetingHarness } from "./ChatGreeting.browser.harness";

const first = ThreadId.makeUnsafe("greeting-first");
const second = ThreadId.makeUnsafe("greeting-second");

describe("greeting identity lifecycle", () => {
  const random = vi.fn(() => 0.5);
  const now = vi.fn(() => new Date(2026, 9, 11, 9));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ready = true;
    now.mockImplementation(() => new Date(2026, 9, 11, 9));
    mocks.choice.mockImplementation(createGreetingSelector({ random, now }));
    useStore.setState({ bootstrapComplete: true, threadHydrationById: {} });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    useStore.setState({ bootstrapComplete: false, threadHydrationById: {} });
  });

  it("stays stable over rerenders, remounts, route revisits and reconnects; a new identity uses the new local time", async () => {
    let screen = await render(<ChatGreetingHarness identity={first} />);
    const originalText = document.querySelector("p")!.textContent;
    await screen.rerender(<ChatGreetingHarness identity={first} />);
    expect(document.querySelector("p")!.textContent).toBe(originalText);
    expect(random).toHaveBeenCalledTimes(3);
    await screen.unmount();
    now.mockImplementation(() => new Date(2026, 9, 11, 18));
    screen = await render(<ChatGreetingHarness identity={second} />);
    const nextText = document.querySelector("p")!.textContent;
    expect(nextText).not.toBe(originalText);
    expect(now).toHaveBeenCalledTimes(2);
    await screen.rerender(<ChatGreetingHarness identity={first} />);
    expect(document.querySelector("p")!.textContent).toBe(originalText);
    mocks.ready = false;
    await screen.rerender(<ChatGreetingHarness identity={first} />);
    expect(document.querySelector("p")).toBeNull();
    mocks.ready = true;
    await screen.rerender(<ChatGreetingHarness identity={first} />);
    expect(document.querySelector("p")!.textContent).toBe(originalText);
    expect(random).toHaveBeenCalledTimes(6);
  });

  it("does not choose copy during boot, settings load, or lazy loading a populated existing thread", async () => {
    mocks.ready = false;
    useStore.setState({ bootstrapComplete: false });
    const screen = await render(
      <ChatGreetingHarness identity={first} isLocalDraftThread={false} />,
    );
    expect(mocks.choice).not.toHaveBeenCalled();
    mocks.ready = true;
    useStore.setState({
      bootstrapComplete: true,
      threadHydrationById: { [first]: { status: "loading" } },
    });
    await screen.rerender(<ChatGreetingHarness identity={first} isLocalDraftThread={false} />);
    expect(mocks.choice).not.toHaveBeenCalled();
    useStore.setState({ threadHydrationById: { [first]: { status: "complete" } } });
    await screen.rerender(
      <ChatGreetingHarness identity={first} isLocalDraftThread={false} hasContent />,
    );
    expect(document.querySelector("p")).toBeNull();
    expect(mocks.choice).not.toHaveBeenCalled();
  });

  it("only updates the name, not the chosen copy, when the shared preference is edited or cleared", async () => {
    const screen = await render(<ChatGreetingHarness identity={first} />);
    const originalText = document.querySelector("p")!.textContent!;
    await screen.rerender(<ChatGreetingHarness identity={first} name="小雨" />);
    expect(document.querySelector("p")!.textContent).toBe(originalText.replace("Youpele", "小雨"));
    await screen.rerender(<ChatGreetingHarness identity={first} name="" />);
    expect(document.querySelector("p")!.textContent).not.toContain("Youpele");
    expect(random).toHaveBeenCalledTimes(3);
  });
});
