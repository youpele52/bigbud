import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, describe, expect, it } from "vitest";

import { selectShowsWelcomeGreeting, useWelcomeTourStore } from "./welcomeTour.store";

const first = ThreadId.makeUnsafe("thread-first");
const second = ThreadId.makeUnsafe("thread-second");

describe("welcomeTour.store", () => {
  beforeEach(() => {
    useWelcomeTourStore.setState({
      open: false,
      mode: "tour",
      welcomeGreetingPending: false,
      welcomeGreetingThreadId: null,
    });
  });

  it("opens in the requested mode and keeps the mode while closing", () => {
    useWelcomeTourStore.getState().openTour("file-access");
    expect(useWelcomeTourStore.getState()).toMatchObject({ open: true, mode: "file-access" });
    useWelcomeTourStore.getState().closeTour();
    expect(useWelcomeTourStore.getState()).toMatchObject({ open: false, mode: "file-access" });
  });

  it("gives the welcome greeting to the first chat that claims it, and only that chat", () => {
    expect(selectShowsWelcomeGreeting(first)(useWelcomeTourStore.getState())).toBe(false);
    useWelcomeTourStore.getState().requestWelcomeGreeting();
    expect(selectShowsWelcomeGreeting(first)(useWelcomeTourStore.getState())).toBe(true);
    useWelcomeTourStore.getState().claimWelcomeGreeting(first);
    useWelcomeTourStore.getState().claimWelcomeGreeting(second);
    const state = useWelcomeTourStore.getState();
    expect(selectShowsWelcomeGreeting(first)(state)).toBe(true);
    expect(selectShowsWelcomeGreeting(second)(state)).toBe(false);
  });
});
