import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatGreeting } from "./ChatGreeting";
import { canShowChatGreeting, type ChatGreetingEligibility } from "./ChatGreeting.logic";

const emptyDraft: ChatGreetingEligibility = {
  isLocalDraftThread: true,
  hydrationStatus: undefined,
  hasOlderMessages: false,
  hasContent: false,
  isWorking: false,
  bootstrapComplete: true,
  settingsReady: true,
};

describe("chat greeting rendering and eligibility", () => {
  it("preserves the existing logo-only screen", () => {
    const markup = renderToStaticMarkup(<ChatGreeting />);
    expect(markup).toContain("flex h-full items-center justify-center");
    expect(markup).toContain("shrink-0 row-start-2 size-8! opacity-70");
    expect(markup).not.toContain("<p ");
  });

  it("places plain-text copy below the logo without interpreting the nickname as markup", () => {
    const markup = renderToStaticMarkup(
      <ChatGreeting greeting="What’s next, <script>alert(1)</script>?" />,
    );
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup.indexOf("<svg")).toBeLessThan(markup.indexOf("<p "));
    expect(markup).toContain("pt-7");
    expect(markup).toContain("text-2xl");
    expect(markup).toContain("font-thin text-foreground");
    expect(markup).not.toContain("animate-");
  });

  it("shimmers both the logo and greeting only when explicitly enabled", () => {
    const markup = renderToStaticMarkup(
      <ChatGreeting greeting="What’s up next, Youpele?" shimmer />,
    );
    expect(markup).toContain("chat-greeting-mark-shimmer");
    expect(markup).toContain("shimmer chat-greeting-message-shimmer");
  });

  it("only greets known-empty drafts or fully hydrated empty canonical threads", () => {
    expect(canShowChatGreeting(emptyDraft)).toBe(true);
    for (const hydrationStatus of ["complete", "loaded"] as const) {
      expect(
        canShowChatGreeting({ ...emptyDraft, isLocalDraftThread: false, hydrationStatus }),
      ).toBe(true);
    }
    for (const hydrationStatus of [
      undefined,
      "unloaded",
      "loading",
      "loadingOlder",
      "failed",
    ] as const) {
      expect(
        canShowChatGreeting({ ...emptyDraft, isLocalDraftThread: false, hydrationStatus }),
      ).toBe(false);
    }
    expect(
      canShowChatGreeting({
        ...emptyDraft,
        isLocalDraftThread: false,
        hydrationStatus: "loaded",
        hasOlderMessages: true,
      }),
    ).toBe(false);
  });

  it.each(["hasContent", "isWorking", "bootstrapComplete", "settingsReady"] as const)(
    "suppresses greeting when %s is not eligible",
    (key) => {
      expect(canShowChatGreeting({ ...emptyDraft, [key]: !emptyDraft[key] })).toBe(false);
    },
  );
});
