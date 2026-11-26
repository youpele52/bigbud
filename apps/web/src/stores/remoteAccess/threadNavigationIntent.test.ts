import { describe, expect, it } from "vitest";

import {
  clearRestoredThreadRoute,
  consumeThreadNavigationIntent,
  markRestoredThreadRoute,
  peekThreadNavigationIntent,
} from "./threadNavigationIntent";

describe("thread navigation intent", () => {
  it("is explicit unless startup marked the route restored, and restored is consumed once", () => {
    expect(consumeThreadNavigationIntent("thread-a")).toBe("explicit");
    markRestoredThreadRoute("thread-a");
    expect(peekThreadNavigationIntent("thread-a")).toBe("restored");
    expect(peekThreadNavigationIntent("thread-b")).toBe("explicit");
    expect(consumeThreadNavigationIntent("thread-a")).toBe("restored");
    expect(consumeThreadNavigationIntent("thread-a")).toBe("explicit");
  });

  it("clearing ends the restored visit", () => {
    markRestoredThreadRoute("thread-c");
    clearRestoredThreadRoute("thread-c");
    expect(peekThreadNavigationIntent("thread-c")).toBe("explicit");
  });
});
