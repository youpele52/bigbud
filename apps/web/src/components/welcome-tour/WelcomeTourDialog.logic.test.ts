import type { ServerProvider } from "@bigbud/contracts";
import { WELCOME_GREETING } from "@bigbud/shared/greeting.messages";
import { describe, expect, it } from "vitest";

import { renderGreeting } from "../../utils/copy/greeting.logic";
import {
  countDiscoveredProviders,
  describeDiscoveredProviders,
  welcomeTourSteps,
} from "./WelcomeTourDialog.logic";

const provider = (installed: boolean) => ({ installed }) as ServerProvider;

describe("welcome tour logic", () => {
  it("walks the three steps in order, or only File Access after a permissions reset", () => {
    expect(welcomeTourSteps("tour")).toEqual(["name", "providers", "file-access"]);
    expect(welcomeTourSteps("file-access")).toEqual(["file-access"]);
  });

  it("counts installed providers and reports checking until the server answers", () => {
    expect(countDiscoveredProviders([])).toBeNull();
    expect(countDiscoveredProviders([provider(true), provider(false), provider(true)])).toBe(2);
    expect(describeDiscoveredProviders(null)).toMatch(/checking/);
    expect(describeDiscoveredProviders(0)).toMatch(/didn’t find/);
    expect(describeDiscoveredProviders(1)).toBe("bigbud found 1 AI provider on this computer.");
    expect(describeDiscoveredProviders(3)).toBe("bigbud found 3 AI providers on this computer.");
  });

  it("greets the landing chat by name, or keeps the canvas copy without one", () => {
    expect(renderGreeting(WELCOME_GREETING, "  Ada ")).toBe("Welcome to bigbud, Ada.");
    expect(renderGreeting(WELCOME_GREETING, "")).toBe("A blank canvas for whatever’s next.");
  });
});
